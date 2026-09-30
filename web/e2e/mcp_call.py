import asyncio
import json
import sys
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport

async def main():
    payload = json.load(sys.stdin)
    async with Client(StreamableHttpTransport(payload['url']+'/mcp/', headers={'X-FactGraph-Token':payload['token']})) as client:
        if payload.get('list'):
            result = [tool.model_dump() for tool in await client.list_tools()]
        else:
            result = (await client.call_tool(payload['tool'], payload['arguments'])).data
        print(json.dumps(result))
asyncio.run(main())
