
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, InitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// --- SendPulse API Logic ---

const SENDPULSE_API_BASE = "https://api.sendpulse.com/chatbots";

async function makeSendPulseRequest(path: string, token: string, params?: URLSearchParams) {
  const url = `${SENDPULSE_API_BASE}${path}${params ? `?${params}` : ''}`;
  try {
    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      console.error(`SendPulse API error! Status: ${response.status}, Body: ${await response.text()}` );
      return { success: false, error: `API request failed with status ${response.status}` };
    }
    return await response.json();
  } catch (error) {
    console.error("Error making SendPulse request:", error);
    return { success: false, error: "An unexpected error occurred." };
  }
}

function createSendPulseServer(authToken: string): McpServer {
    const server = new McpServer({
        name: "sendpulse-chatbots",
        version: "1.0.0",
    });

    // Tool: Get Account Info
    server.tool(
      "get_account_info",
      "Returns information about your current account pricing plan, the number of messages in your plan, bots, contacts, list of tags, and variables",
      {},
      async () => {
        console.log("[TOOL CALL] Tool: get_account_info");
        const result = await makeSendPulseRequest("/account", authToken);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    // Tool: Get Bots List
    server.tool(
      "get_bots_list",
      "Returns lists of bots with information about each: bot ID, channel information, number of received and unread messages, bot status, and creation date",
      {},
      async () => {
        console.log("[TOOL CALL] Tool: get_bots_list");
        const result = await makeSendPulseRequest("/bots", authToken);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    // Tool: Get Dialogs List
    server.tool(
      "get_dialogs",
      "Returns information about your dialogs from all channels",
      {
        size: z.number().optional().describe("The limit of pagination items, that will be returned"),
        skip: z.number().optional().describe("The offset of pagination items, where starts a current items batch"),
        search_after: z.string().optional().describe("The id of element after which elements will be searched"),
        order: z.enum(["asc", "desc"]).optional().describe("Sort order ASC or DESC"),
      },
      async (args) => {
        console.log(`[TOOL CALL] Tool: get_dialogs, Arguments: ${JSON.stringify(args)}`);
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(args)) {
            if (value !== undefined && value !== null) {
                params.append(key, String(value));
            }
        }
        const result = await makeSendPulseRequest("/dialogs", authToken, params);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    return server;
}


// --- Express Server Implementation ---

const app = express();
app.use(express.json());

const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    
    const initializeRequest = req.body as InitializeRequest;
    let authToken: string | undefined;

    // 1. Check for Authorization header (e.g., "Bearer <token>")
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        authToken = authHeader.substring(7);
    }

    // 2. If not in header, fall back to checking the request body
    if (!authToken) {
        authToken = (initializeRequest.params as any)?.authorization as string | undefined;
    }

    if (!authToken) {
        res.status(401).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Unauthorized: Authorization token is missing in initialize request.' },
            id: (initializeRequest as any).id,
        });
        return;
    }

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        transports[newSessionId] = transport;
        console.log(`Session initialized: ${newSessionId}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log(`Session closed: ${transport.sessionId}`);
      }
    };
    
    // Create a server instance with the token provided for this specific session
    const server = createSendPulseServer(authToken);
    await server.connect(transport);

  } else {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session ID provided or invalid request type.' },
      id: (req.body as any)?.id || null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

const handleSessionRequest = async (req: express.Request, res: express.Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};

app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

const port = 3000;
app.listen(port, () => {
    console.log(`SendPulse MCP HTTP Server running on http://localhost:${port}/mcp`);
});
