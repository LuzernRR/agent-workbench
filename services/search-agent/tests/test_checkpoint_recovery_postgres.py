from __future__ import annotations

import asyncio
import os
import selectors
import uuid
from typing import TypedDict

import pytest
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, START, StateGraph
from psycopg import AsyncConnection

DATABASE_URL = os.environ.get("WORKBENCH_DATABASE_URL", "").strip()
RUN_LIVE_INTEGRATION = (
    os.environ.get("WORKBENCH_LIVE_INTEGRATION") == "1" and bool(DATABASE_URL)
)


class RecoveryState(TypedDict):
    value: str
    marker: str


async def _record_value(state: RecoveryState) -> dict[str, str]:
    return {"marker": f"stored:{state['value']}"}


async def _finalize_value(state: RecoveryState) -> dict[str, str]:
    return {"marker": f"finalized:{state['value']}"}


async def _delete_thread_checkpoints(database_url: str, thread_id: str) -> None:
    connection = await AsyncConnection.connect(database_url, autocommit=True)
    try:
        for table in ("checkpoint_writes", "checkpoint_blobs", "checkpoints"):
            await connection.execute(
                f"DELETE FROM {table} WHERE thread_id = %s",
                (thread_id,),
            )
    finally:
        await connection.close()


async def _prove_exact_authority_ignores_newer_orphan() -> None:
    thread_id = f"issue50_recovery_{uuid.uuid4().hex}"
    root_config = {
        "configurable": {
            "thread_id": thread_id,
            "checkpoint_ns": "",
        }
    }
    try:
        async with AsyncPostgresSaver.from_conn_string(DATABASE_URL) as saver:
            await saver.setup()
            builder = StateGraph(RecoveryState)
            builder.add_node("record", _record_value)
            builder.add_node("finalize", _finalize_value)
            builder.add_edge(START, "record")
            builder.add_edge("record", "finalize")
            builder.add_edge("finalize", END)
            graph = builder.compile(
                checkpointer=saver,
                interrupt_before=["finalize"],
            )

            await graph.ainvoke(
                {"value": "authority", "marker": ""},
                config=root_config,
                durability="sync",
            )
            authority = await graph.aget_state(root_config)
            authority_config = authority.config
            assert authority_config["configurable"]["checkpoint_ns"] == ""
            assert authority_config["configurable"]["checkpoint_id"]
            assert authority.next == ("finalize",)

            orphan_config = await graph.aupdate_state(
                authority_config,
                {"value": "newer-orphan", "marker": "stored:newer-orphan"},
                as_node="record",
            )
            latest = await graph.aget_state(root_config)
            exact = await graph.aget_state(authority_config)
            saver_tuple = await saver.aget_tuple(authority_config)

            assert latest.values == {
                "value": "newer-orphan",
                "marker": "stored:newer-orphan",
            }
            assert latest.config == orphan_config
            assert exact.values == {
                "value": "authority",
                "marker": "stored:authority",
            }
            assert exact.config == authority_config
            assert saver_tuple is not None
            assert saver_tuple.config == authority_config

            resumed_parts = [
                part
                async for part in graph.astream(
                    None,
                    config=authority_config,
                    stream_mode=["values", "checkpoints"],
                    durability="sync",
                )
            ]
            resumed_values = [part for mode, part in resumed_parts if mode == "values"]
            resumed_checkpoints = [
                part for mode, part in resumed_parts if mode == "checkpoints"
            ]

            assert resumed_values[-1] == {
                "value": "authority",
                "marker": "finalized:authority",
            }
            assert resumed_checkpoints[0]["metadata"]["source"] == "fork"
            assert resumed_checkpoints[0]["parent_config"] == authority_config
            assert resumed_checkpoints[0]["config"] != orphan_config
            assert resumed_checkpoints[0]["values"] == {
                "value": "authority",
                "marker": "stored:authority",
            }
            assert resumed_checkpoints[-1]["values"] == resumed_values[-1]
    finally:
        await _delete_thread_checkpoints(DATABASE_URL, thread_id)


@pytest.mark.skipif(
    not RUN_LIVE_INTEGRATION,
    reason="requires WORKBENCH_LIVE_INTEGRATION=1 and WORKBENCH_DATABASE_URL",
)
def test_real_postgres_micrograph_resumes_exact_authority_not_newer_orphan() -> None:
    asyncio.run(
        _prove_exact_authority_ignores_newer_orphan(),
        loop_factory=lambda: asyncio.SelectorEventLoop(selectors.SelectSelector()),
    )
