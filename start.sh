#!/bin/bash
echo "🎮 Starting DarkMC Discord Bot..."
if [ ! -f .env ]; then echo "❌ .env file not found!"; exit 1; fi
source .env
if [ -z "$DISCORD_TOKEN" ]; then echo "❌ DISCORD_TOKEN not set!"; exit 1; fi
if [ -z "$CLIENT_ID" ]; then echo "❌ CLIENT_ID not set!"; exit 1; fi
echo "✅ Starting bot..."
node index.js
