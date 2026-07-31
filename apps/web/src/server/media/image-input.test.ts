import { describe, expect, it } from "vitest";
import { ImageInputError, MAX_IMAGE_INPUT_BYTES, negotiateImageInputs, prepareImageInput, toProviderImageContent } from "./image-input";

function png(width = 3, height = 2) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function input(overrides: Partial<{ id: string; mimeType: string; sizeBytes: number; bytes: Buffer }> = {}) {
  const bytes = overrides.bytes || png();
  return {
    id: overrides.id || "att_image",
    mimeType: overrides.mimeType || "image/png",
    sizeBytes: overrides.sizeBytes ?? bytes.byteLength,
    bytes
  };
}

function expectImageError(action: () => unknown, code: ImageInputError["code"]) {
  try {
    action();
    throw new Error("expected image input validation error");
  } catch (error) {
    expect(error).toBeInstanceOf(ImageInputError);
    expect(error).toMatchObject({ code });
  }
}

describe("图片输入能力协商", () => {
  it("只把安全引用交给跨服务请求，图片 bytes 不会出现在引用或不可用提示中", () => {
    const prepared = prepareImageInput(input());
    const negotiation = negotiateImageInputs([prepared], false);

    expect(negotiation.status).toBe("unsupported");
    expect(negotiation.references).toEqual([{
      attachmentId: "att_image",
      mimeType: "image/png",
      sizeBytes: 24,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    }]);
    expect(JSON.stringify(negotiation)).not.toContain("base64");
    expect(JSON.stringify(negotiation)).not.toContain(prepared.bytes.toString("base64"));
    expect(negotiation.context).toContain("未发送给模型、搜索工具或作为回答依据");
  });

  it("拒绝 MIME 伪造、超限文件和像素炸弹", () => {
    expectImageError(() => prepareImageInput(input({ mimeType: "image/jpeg" })), "IMAGE_INPUT_MIME_MISMATCH");
    expectImageError(() => prepareImageInput(input({ sizeBytes: MAX_IMAGE_INPUT_BYTES + 1 })), "IMAGE_INPUT_TOO_LARGE");
    expectImageError(() => prepareImageInput(input({ bytes: png(10_000, 10_000) })), "IMAGE_INPUT_DIMENSIONS_INVALID");
  });

  it("即使模型日后声明支持，在视觉 adapter 接入前仍会 fail closed", () => {
    const prepared = prepareImageInput(input());
    const negotiation = negotiateImageInputs([prepared], true);

    expect(negotiation.status).toBe("adapter_unavailable");
    expect(negotiation.context).toContain("适配器尚未启用");
  });

  it("每轮图片数量受到硬限制，避免把大量图片送入未来视觉模型", () => {
    const prepared = prepareImageInput(input());

    expectImageError(() => negotiateImageInputs(Array.from({ length: 5 }, () => prepared), false), "IMAGE_INPUT_TOO_MANY");
  });

  it("未来 Provider 内容仅能从服务端内存的受限对象构造", () => {
    const part = toProviderImageContent(prepareImageInput(input()));

    expect(part).toMatchObject({ type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/u) } });
  });
});
