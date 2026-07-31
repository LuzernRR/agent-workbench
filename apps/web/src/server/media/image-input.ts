import { createHash } from "node:crypto";

/**
 * 图片在服务端的最小可信边界。引用可以跨 BFF 与 Search Agent 传递；原始
 * bytes 仅保留在本进程，绝不能写入 AgentEvent、日志或跨服务 JSON。
 */
export const IMAGE_INPUT_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type ImageInputMimeType = (typeof IMAGE_INPUT_MIME_TYPES)[number];
export const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_INPUT_PIXELS = 40_000_000;
export const MAX_IMAGE_INPUTS_PER_RUN = 4;

export type ImageInputReference = {
  attachmentId: string;
  mimeType: ImageInputMimeType;
  sizeBytes: number;
  sha256: string;
};

/** Server-only: do not add this type to a response or event payload. */
export type PreparedImageInput = ImageInputReference & { bytes: Buffer };

export type ProviderImageContentPart = {
  type: "image_url";
  image_url: { url: string };
};

type StoredImage = {
  id: string;
  mimeType: string;
  sizeBytes: number;
  bytes: Buffer;
};

export class ImageInputError extends Error {
  constructor(readonly code: "IMAGE_INPUT_MIME_UNSUPPORTED" | "IMAGE_INPUT_MIME_MISMATCH" | "IMAGE_INPUT_TOO_LARGE" | "IMAGE_INPUT_DIMENSIONS_INVALID" | "IMAGE_INPUT_TOO_MANY", message: string) {
    super(message);
    this.name = "ImageInputError";
  }
}

function isImageMimeType(value: string): value is ImageInputMimeType {
  return (IMAGE_INPUT_MIME_TYPES as readonly string[]).includes(value);
}

function readDimensions(mimeType: ImageInputMimeType, bytes: Buffer): { width: number; height: number } {
  if (mimeType === "image/png") {
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") throw new ImageInputError("IMAGE_INPUT_MIME_MISMATCH", "图片内容与声明格式不一致");
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType === "image/gif") {
    if (bytes.length < 10 || !["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) throw new ImageInputError("IMAGE_INPUT_MIME_MISMATCH", "图片内容与声明格式不一致");
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (mimeType === "image/jpeg") return jpegDimensions(bytes);
  return webpDimensions(bytes);
}

function jpegDimensions(bytes: Buffer) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new ImageInputError("IMAGE_INPUT_MIME_MISMATCH", "图片内容与声明格式不一致");
  let offset = 2;
  while (offset + 8 <= bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  throw new ImageInputError("IMAGE_INPUT_DIMENSIONS_INVALID", "图片尺寸无法安全解析");
}

function webpDimensions(bytes: Buffer) {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") throw new ImageInputError("IMAGE_INPUT_MIME_MISMATCH", "图片内容与声明格式不一致");
  const kind = bytes.toString("ascii", 12, 16);
  if (kind === "VP8X" && bytes.length >= 30) {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  if (kind === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b1 = bytes[21];
    const b2 = bytes[22];
    const b3 = bytes[23];
    const b4 = bytes[24];
    return { width: 1 + b1 + ((b2 & 0x3f) << 8), height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10) };
  }
  throw new ImageInputError("IMAGE_INPUT_DIMENSIONS_INVALID", "图片尺寸无法安全解析");
}

export function prepareImageInput(input: StoredImage): PreparedImageInput {
  if (!isImageMimeType(input.mimeType)) throw new ImageInputError("IMAGE_INPUT_MIME_UNSUPPORTED", "暂不支持该图片格式");
  if (input.sizeBytes !== input.bytes.byteLength || input.sizeBytes <= 0 || input.sizeBytes > MAX_IMAGE_INPUT_BYTES) throw new ImageInputError("IMAGE_INPUT_TOO_LARGE", "图片超过安全大小限制");
  const { width, height } = readDimensions(input.mimeType, input.bytes);
  if (!width || !height || width * height > MAX_IMAGE_INPUT_PIXELS) throw new ImageInputError("IMAGE_INPUT_DIMENSIONS_INVALID", "图片像素超过安全限制");
  return {
    attachmentId: input.id,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    bytes: input.bytes
  };
}

/** 仅由未来接入视觉 Provider 的服务端适配器调用，不能放入事件或日志。 */
export function toProviderImageContent(input: PreparedImageInput): ProviderImageContentPart {
  return { type: "image_url", image_url: { url: `data:${input.mimeType};base64,${input.bytes.toString("base64")}` } };
}

export type ImageInputNegotiation = {
  status: "not_requested" | "unsupported" | "adapter_unavailable";
  references: ImageInputReference[];
  context: string;
};

/**
 * 当前 Search Agent 没有视觉 Provider adapter。即使未来模型配置声明支持，
 * 在 adapter 实装前仍会 fail closed，绝不把图片当作已经读取。
 */
export function negotiateImageInputs(inputs: PreparedImageInput[], modelSupportsImageInput: boolean): ImageInputNegotiation {
  if (!inputs.length) return { status: "not_requested", references: [], context: "" };
  if (inputs.length > MAX_IMAGE_INPUTS_PER_RUN) throw new ImageInputError("IMAGE_INPUT_TOO_MANY", "单次最多处理 4 张图片");
  const references = inputs.map(({ bytes: _bytes, ...reference }) => reference);
  if (!modelSupportsImageInput) {
    return {
      status: "unsupported",
      references,
      context: `图片输入说明：本次收到 ${inputs.length} 张图片；当前所选模型不支持图片读取，图片内容未发送给模型、搜索工具或作为回答依据。`
    };
  }
  return {
    status: "adapter_unavailable",
    references,
    context: `图片输入说明：本次收到 ${inputs.length} 张图片；视觉模型适配器尚未启用，图片内容未发送给模型、搜索工具或作为回答依据。`
  };
}
