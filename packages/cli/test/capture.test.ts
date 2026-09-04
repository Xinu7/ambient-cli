import { describe, expect, it } from "vitest";
import {
  imageDimensions,
  looksLikeImagePath,
  normalizeDroppedPath,
  sniffMediaType,
} from "../src/tui/capture.js";

// A minimal PNG header: 8-byte signature + IHDR chunk with width=800, height=600.
const png = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a, // signature
  0x00,
  0x00,
  0x00,
  0x0d, // IHDR length (13)
  0x49,
  0x48,
  0x44,
  0x52, // "IHDR"
  0x00,
  0x00,
  0x03,
  0x20, // width = 800
  0x00,
  0x00,
  0x02,
  0x58, // height = 600
]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

describe("capture pure helpers (slice 8)", () => {
  it("normalizeDroppedPath strips quotes + backslash-escaped spaces", () => {
    expect(normalizeDroppedPath("'/Users/alice/My Shots/a.png'")).toBe(
      "/Users/alice/My Shots/a.png",
    );
    expect(normalizeDroppedPath("/Users/alice/My\\ Shots/a.png")).toBe(
      "/Users/alice/My Shots/a.png",
    );
  });

  it("looksLikeImagePath accepts a real image PATH, rejects prose / URLs / multi-line / non-image", () => {
    expect(looksLikeImagePath("/Users/alice/shot.png")).toBe(true);
    expect(looksLikeImagePath("'/Users/alice/My Shots/a.jpeg'")).toBe(true);
    expect(looksLikeImagePath("./relative/pic.webp")).toBe(true);
    expect(looksLikeImagePath("just some typed words")).toBe(false);
    expect(looksLikeImagePath("/Users/alice/a.png\nsecond line")).toBe(false);
    expect(looksLikeImagePath("/Users/alice/notes.txt")).toBe(false);
    // The audit's bug: prose or an image URL ending in ".png" must NOT be diverted to attach (text-loss).
    expect(looksLikeImagePath("here is the file photo.png")).toBe(false); // no path prefix → not a path
    expect(looksLikeImagePath("https://example.com/photo.png")).toBe(false); // URL, not a local path
    expect(looksLikeImagePath("check out cover.jpg for details")).toBe(false);
  });

  it("sniffMediaType reads magic bytes (authoritative, not the extension)", () => {
    expect(sniffMediaType(png)).toBe("image/png");
    expect(sniffMediaType(jpeg)).toBe("image/jpeg");
    expect(sniffMediaType(gif)).toBe("image/gif");
    expect(sniffMediaType(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
  });

  it("imageDimensions reads a PNG IHDR", () => {
    expect(imageDimensions(png, "image/png")).toEqual({ width: 800, height: 600 });
  });
});
