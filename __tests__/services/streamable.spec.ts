import http from "node:http";
import { AddressInfo } from "node:net";
import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { startHTTPStreamableServer } from "../../src/services/streamable";

let lastServer: http.Server | undefined;
let createdServer: { connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } | undefined;

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => {
  class MockStreamableHTTPServerTransport {
    sessionId: string;
    onsessioninitialized?: (sid: string) => void;
    onclose?: () => void;
    constructor(options: { onsessioninitialized?: (sid: string) => void }) {
      this.sessionId = "test-session";
      this.onsessioninitialized = options.onsessioninitialized;
    }
    async handleRequest(req: http.IncomingMessage, res: http.ServerResponse, body?: unknown) {
      if (req.method === "POST") {
        let parsed: any = body;
        if (typeof parsed === "string") {
          try {
            parsed = JSON.parse(parsed);
          } catch {}
        }
        if (parsed && parsed.method === "initialize") {
          this.onsessioninitialized && this.onsessioninitialized(this.sessionId);
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200).end(
            JSON.stringify({ jsonrpc: "2.0", id: parsed.id ?? null, result: { capabilities: {} } }),
          );
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200).end(JSON.stringify({ jsonrpc: "2.0", id: parsed?.id ?? null, result: {} }));
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        res.setHeader("Content-Type", "text/plain");
        res.writeHead(200).end("ok");
        return;
      }
      res.writeHead(404).end("not found");
    }
    close() {
      this.onclose && this.onclose();
    }
  }
  return { StreamableHTTPServerTransport: MockStreamableHTTPServerTransport };
});

vi.mock("../../src/utils", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createBaseHttpServer: vi.fn((port: number, endpoint: string, handlers: any) => {
      const server = http.createServer((req, res) => handlers.handleRequest(req, res));
      server.listen(port);
      lastServer = server;
      return server;
    }),
    renderMermaid: vi.fn(async () => ({ svg: "<svg></svg>", screenshot: Buffer.from("png") })),
    getBody: vi.fn(async (req: http.IncomingMessage) => {
      return await new Promise<string>((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
      });
    }),
  } as any;
});

vi.mock("../../src/services/fileStorage", () => {
  return {
    FileStorageService: class MockFileStorageService {
      token: string | undefined;
      constructor(token?: string) {
        this.token = token;
      }
      async storeFile(buffer: Buffer, filename: string, mimeType: string) {
        return { url: `https://files.example/${filename}`, fileId: "file-123", mimeType };
      }
    },
  };
});

function getServerAddress(server: http.Server) {
  const addr = server.address() as AddressInfo | null;
  if (!addr) throw new Error("Server not listening");
  return `http://127.0.0.1:${addr.port}`;
}

async function httpRequest(url: string, options: http.RequestOptions & { body?: string | Buffer } = {}) {
  return await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request(url, { method: "GET", ...options }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe("HTTP Streamable endpoints", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const createServer = (/* apiKey?: string */) => {
      const s = {
        connect: vi.fn(),
        close: vi.fn(),
      } as unknown as { connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
      createdServer = s as any;
      return s as any;
    };
    await startHTTPStreamableServer(createServer, "/mcp", 0);
    server = lastServer as http.Server;
    baseUrl = getServerAddress(server);
  });

  afterAll(async () => {
    if (server && server.listening) {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await httpRequest(`${baseUrl}/render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mermaid: "graph TD;A-->B;" }) });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error.message).toMatch(/Unauthorized/);
  });

  it("validates mermaid input", async () => {
    const res = await httpRequest(`${baseUrl}/render`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.message).toContain("'mermaid' is required");
  });

  it("returns svg when outputType=svg", async () => {
    const res = await httpRequest(`${baseUrl}/render`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ mermaid: "graph TD;A-->B;", outputType: "svg" }),
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.svg).toBeDefined();
    expect(json.mimeType).toBe("image/svg+xml");
  });

  it("stores png by default and returns file url", async () => {
    const res = await httpRequest(`${baseUrl}/render`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ mermaid: "graph TD;A-->B;" }),
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.url).toMatch(/https:\/\/files\.example\/mermaid-/);
    expect(json.mimeType).toBe("image/png");
  });

  it("rejects POST to /mcp without initialize when no session id", async () => {
    const res = await httpRequest(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "non_initialize" }),
    });
    expect(res.status).toBe(400);
    const json = JSON.parse(res.body);
    expect(json.error.message).toMatch(/No valid session ID/);
  });

}); 