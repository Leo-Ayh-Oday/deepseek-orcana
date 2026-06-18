import { describe, expect, test } from "bun:test";
import { app } from "./index";

describe("GET /health", () => {
  test("returns 200 with {status:'ok'}", async () => {
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });
});
