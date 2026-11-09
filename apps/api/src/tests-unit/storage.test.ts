import { describe, it, expect, mock, beforeAll, afterAll, beforeEach } from "bun:test";

const sentCommands: any[] = [];

class PutObjectCommand {
  constructor(public input: any) {}
}
class DeleteObjectCommand {
  constructor(public input: any) {}
}
class HeadObjectCommand {
  constructor(public input: any) {}
}
class GetObjectCommand {
  constructor(public input: any) {}
}
class ListObjectsV2Command {
  constructor(public input: any) {}
}

const signedUrls: any[] = [];
const mockGetSignedUrl = mock(async (_client: any, command: any, options: any) => {
  const url = `https://signed.example.com/${command.input.Key}?expires=${options.expiresIn}`;
  signedUrls.push({ command: command.input.Key, expiresIn: options.expiresIn });
  return url;
});

class MockS3Client {
  send = mock(async (command: any) => {
    sentCommands.push(command);
    if (command instanceof HeadObjectCommand) {
      if (command.input.Key === "missing") {
        const err: any = new Error("NotFound");
        err.name = "NotFound";
        throw err;
      }
      return {};
    }
    if (command instanceof GetObjectCommand) {
      if (command.input.Key === "missing") {
        const err: any = new Error("NoSuchKey");
        err.name = "NoSuchKey";
        throw err;
      }
      return { Body: new ReadableStream() };
    }
    // Two pages: listKeys has to follow the ContinuationToken to the end
    if (command instanceof ListObjectsV2Command) {
      return command.input.ContinuationToken
        ? { Contents: [{ Key: `${command.input.Prefix}c.webp` }], IsTruncated: false }
        : {
            Contents: [
              { Key: `${command.input.Prefix}a.webp` },
              { Key: `${command.input.Prefix}b.webp` },
            ],
            IsTruncated: true,
            NextContinuationToken: "page-2",
          };
    }
    return {};
  });
}

mock.module("@aws-sdk/client-s3", () => ({
  S3Client: MockS3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
}));

mock.module("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mockGetSignedUrl,
}));

let storage: any;

beforeAll(async () => {
  process.env.DEFAULT_STORAGE_PROVIDER = "s3";
  process.env.S3_ACCESS_KEY = "test-access";
  process.env.S3_SECRET_KEY = "test-secret";
  process.env.S3_ENDPOINT = "http://localhost:9000";
  process.env.S3_BUCKET = "kitsuden-media";
  process.env.S3_PUBLIC_URL = "http://localhost:9000";
  process.env.S3_REGION = "us-east-1";

  // @ts-ignore — force a fresh module instance for the s3 provider test
  storage = await import("../lib/storage?s3");
});

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  sentCommands.length = 0;
  signedUrls.length = 0;
  mockGetSignedUrl.mockClear?.();
});

describe("storage", () => {
  it("generateS3Key creates a date-prefixed sanitized key", () => {
    const key = storage.generateS3Key("my file.png", "uploads");
    expect(key).toMatch(/^uploads\/\d{4}\/\d{2}\/[a-f0-9]+-my_file\.png$/);
  });

  it("uploadFile uploads a File and returns s3Key, url and size", async () => {
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    const result = await storage.uploadFile(file, "hello.txt", "text/plain", "docs");

    expect(result.size).toBe(5);
    expect(result.url).toContain("kitsuden-media/");
    expect(sentCommands.length).toBe(1);
    expect(sentCommands[0]).toBeInstanceOf(PutObjectCommand);
    expect(sentCommands[0].input.Bucket).toBe("kitsuden-media");
    expect(sentCommands[0].input.ContentType).toBe("text/plain");
  });

  it("uploadBuffer uploads a buffer with a custom key", async () => {
    const buffer = Buffer.from("buffer-data");
    const result = await storage.uploadBuffer(buffer, "custom/key.bin", "application/octet-stream");

    expect(result.size).toBe(11);
    expect(result.s3Key).toBe("custom/key.bin");
    expect(sentCommands[0]).toBeInstanceOf(PutObjectCommand);
  });

  it("deleteFile sends DeleteObjectCommand", async () => {
    await storage.deleteFile("custom/key.bin");
    expect(sentCommands.length).toBe(1);
    expect(sentCommands[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(sentCommands[0].input.Key).toBe("custom/key.bin");
  });

  it("fileExists returns true when object exists", async () => {
    const result = await storage.fileExists("exists");
    expect(result).toBe(true);
    expect(sentCommands[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it("fileExists returns false when object is missing", async () => {
    const result = await storage.fileExists("missing");
    expect(result).toBe(false);
  });

  it("getFile returns a stream for existing object", async () => {
    const result = await storage.getFile("exists");
    expect(result).toBeInstanceOf(ReadableStream);
  });

  it("getFile returns null for missing object", async () => {
    const result = await storage.getFile("missing");
    expect(result).toBeNull();
  });

  it("generateSignedDownloadUrl clamps expiry and delegates to getSignedUrl", async () => {
    const url = await storage.generateSignedDownloadUrl("my/key", 30);
    expect(url).toContain("my/key");
    expect(url).toContain("expires=60");
  });

  it("generateSignedDownloadUrl clamps max expiry to 86400", async () => {
    const url = await storage.generateSignedDownloadUrl("my/key", 100000);
    expect(url).toContain("expires=86400");
  });

  it("listKeys pages through ListObjectsV2 until the end", async () => {
    const keys = await storage.listKeys("transforms/abc/");
    expect(keys).toEqual([
      "transforms/abc/a.webp",
      "transforms/abc/b.webp",
      "transforms/abc/c.webp",
    ]);
    const listings = sentCommands.filter((c) => c instanceof ListObjectsV2Command);
    expect(listings.map((c) => c.input.ContinuationToken)).toEqual([undefined, "page-2"]);
    expect(listings.every((c) => c.input.Bucket === "kitsuden-media")).toBe(true);
  });

  it("throws when storage provider is local", async () => {
    process.env.DEFAULT_STORAGE_PROVIDER = "local";
    // @ts-ignore — fresh instance for the local provider test
    const localStorage = await import("../lib/storage?local");
    const file = new File(["x"], "x.txt", { type: "text/plain" });
    expect(localStorage.uploadFile(file, "x.txt", "text/plain")).rejects.toThrow("local");
  });
});
