# MCP Server for SendPulse Chatbots

This project is an implementation of a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server designed to work with the [SendPulse Chatbots API](https://sendpulse.com/swagger/chatbots/?lang=en). It allows Large Language Models (LLMs) like those from OpenAI to interact with the SendPulse API through a standardized set of tools.

This server is built with TypeScript and runs on Node.js using the Express framework.

## Features

The server exposes the following tools to the LLM, based on the SendPulse OpenAPI specification:

- `get_account_info`: Returns information about the current SendPulse account, including pricing plan, message counts, bots, contacts, etc.
- `get_bots_list`: Returns a list of all connected chatbots with details for each.
- `get_dialogs`: Returns a list of dialogs from all channels, with support for pagination and sorting.

## Authentication

The server supports two flexible methods for authenticating requests to the SendPulse API, which are handled on a per-session basis.

### Method 1: API ID & Secret (Recommended)

The client can provide SendPulse API credentials by sending two custom HTTP headers:

- `x-sp-id`: Your SendPulse API ID.
- `x-sp-secret`: Your SendPulse API Secret.

Upon receiving these headers, the MCP server will automatically perform the OAuth 2.0 `client_credentials` flow to obtain a temporary access token from SendPulse. These tokens are cached in memory to improve performance for subsequent requests from the same user (same API ID).

### Method 2: Direct OAuth Token

The client can provide a pre-existing, valid SendPulse OAuth 2.0 token directly. This is supported in two ways:

1.  **Via `Authorization` Header (Standard):**
    - `Authorization: Bearer <your_oauth_token>`
2.  **Via MCP `initialize` Request Body (Legacy/Compatibility):**
    - As part of the MCP JSON configuration.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later recommended)
- [npm](https://www.npmjs.com/) (usually comes with Node.js)
- [ngrok](https://ngrok.com/download) (for exposing the local server to the internet)

### Installation

1.  Clone the repository (if applicable).
2.  Install the project dependencies:
    ```bash
    npm install
    ```

### Build

To build the project, run the following command.

```bash
npm run build
```

### Running the Server

Once the project is built, you can start the server:

```bash
npm start
```

You should see a confirmation message in your console:
`SendPulse MCP HTTP Server running on http://localhost:3000/mcp`

### Exposing the TEST Server with ngrok

To make your local server accessible to services like the OpenAI sandbox, you need to expose it to the internet. Open a **new terminal window** and run:

```bash
ngrok http 3000
```

Ngrok will provide you with a public `https://` URL (e.g., `https://random-string.ngrok-free.app`). Use this URL (https://random-string.ngrok-free.app/mcp) when configuring the MCP tool in your LLM client.

**Note:** To bypass the ngrok browser warning page, you may need to configure your LLM client to send an additional header with every request, for example: `ngrok-skip-browser-warning: "true"`.