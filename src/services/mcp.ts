import type { Server } from "node:http";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { DeploymentStatusService } from "@/services/deployment-status";

const DEFAULT_MCP_PORT = 3827;
const MCP_HOST = "127.0.0.1";
const MCP_PATH = "/mcp";

let httpServer: Server | null = null;
let transport: StreamableHTTPServerTransport | null = null;

export async function startMcpServer(): Promise<void> {
  if (httpServer) {
    return;
  }

  const { deploymentStatus } = await import("@/services/bfd-services");
  const mcpServer = createDeploymentMcpServer(deploymentStatus);
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await mcpServer.connect(transport);

  httpServer = createServer((request, response) => {
    handleMcpRequest(request, response).catch((error) => {
      console.error("MCP request failed:", error);
      if (!response.headersSent) {
        response.writeHead(500).end("MCP request failed");
      }
    });
  });

  const port = mcpPort();
  await new Promise<void>((resolve, reject) => {
    httpServer?.once("error", reject);
    httpServer?.listen(port, MCP_HOST, resolve);
  });

  console.log(`MCP server listening on http://${MCP_HOST}:${port}${MCP_PATH}`);
}

export async function stopMcpServer(): Promise<void> {
  await Promise.all([closeTransport(), closeHttpServer()]);
}

function createDeploymentMcpServer(
  deploymentStatus: DeploymentStatusService
): McpServer {
  const server = new McpServer({
    name: "bfd-deployments",
    version: "0.1.0",
  });

  server.registerTool(
    "ticket_deployment_status",
    {
      description:
        "Checks whether a Jira ticket is deployed and whether the deployed branch has new commits since deployment.",
      inputSchema: {
        ticketKey: z.string().describe("Jira ticket key, for example PC-1234"),
      },
      title: "Ticket deployment status",
    },
    async ({ ticketKey }) =>
      jsonResult(await deploymentStatus.getTicketStatus(ticketKey))
  );

  server.registerTool(
    "list_deployments",
    {
      description:
        "Lists current ArgoCD deployments with server, branch, date, sync/health status, and freshness information.",
      inputSchema: {},
      title: "List deployments",
    },
    async () =>
      jsonResult({
        deployments: await deploymentStatus.listDeploymentStatuses(),
      })
  );

  return server;
}

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.url?.split("?")[0] !== MCP_PATH) {
    response.writeHead(404).end("Not found");
    return;
  }

  if (!transport) {
    response.writeHead(503).end("MCP server is not ready");
    return;
  }

  await transport.handleRequest(request, response);
}

function mcpPort(): number {
  const configured = Number(process.env.BFD_MCP_PORT);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MCP_PORT;
}

async function closeTransport(): Promise<void> {
  const current = transport;
  transport = null;
  await current?.close();
}

function closeHttpServer(): Promise<void> {
  const current = httpServer;
  httpServer = null;
  if (!current) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    current.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function jsonResult(value: unknown) {
  const structuredContent =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };

  return {
    content: [
      {
        text: JSON.stringify(value, null, 2),
        type: "text" as const,
      },
    ],
    structuredContent,
  };
}
