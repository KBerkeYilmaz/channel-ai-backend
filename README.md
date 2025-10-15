# 🚀 YouTube Channel AI Processor

A high-performance backend service for creator chat functionality built with **Hono + Bun**, following modern best practices with TypeScript, OpenAPI documentation, and structured logging.

## ✨ Features

- **⚡ High Performance**: Built with Bun runtime and Hono framework
- **📚 OpenAPI Docs**: Auto-generated API documentation with Swagger UI
- **🔍 Structured Logging**: JSON logging with Pino for production monitoring
- **🛡️ Type Safety**: Full TypeScript coverage with Zod validation
- **🌐 CORS Ready**: Configured for cross-origin requests
- **🔧 Developer Experience**: Hot reload, linting, and formatting

## 🏗️ Architecture

```
├── src/
│   ├── config/          # Configuration and environment
│   ├── middleware/      # CORS, logging, auth middleware
│   ├── routes/          # API route handlers
│   ├── types/           # TypeScript type definitions
│   └── lib/             # Utility functions (TODO)
├── index.ts             # Main server entry point
└── package.json         # Dependencies and scripts
```

## 🚀 Quick Start

### Prerequisites
- [Bun](https://bun.sh) >= 1.0.0

### Installation
```bash
# Clone and setup
git clone <your-repo>
cd yt-channel-ai-processor

# Install dependencies
bun install

# Copy environment variables
cp .env.example .env
# Edit .env with your API keys
```

### Development
```bash
# Start with hot reload
bun run dev

# Or use the raw command
bun run --hot index.ts
```

### Production
```bash
# Build and start
bun run build
bun run start
```

## 📡 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | API information and available endpoints |
| `GET` | `/health` | System health check |
| `GET` | `/docs` | Interactive API documentation (Swagger UI) |
| `GET` | `/api-docs` | OpenAPI specification (JSON) |
| `GET` | `/api/creators` | List all creators |
| `GET` | `/api/creators/:id/info` | Get creator details |
| `POST` | `/api/chat` | Streaming AI chat |

## 🧪 Testing

```bash
# Health check
curl http://localhost:3001/health

# List creators
curl http://localhost:3001/api/creators

# Chat test
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "role": "user",
        "parts": [{"type": "text", "text": "[CREATOR:landingmark] Hello!"}]
      }
    ]
  }'
```

## 📚 Documentation

- **Interactive Docs**: Visit `http://localhost:3001/docs` when running
- **OpenAPI Spec**: Available at `http://localhost:3001/api-docs`
- **Health Status**: Check `http://localhost:3001/health`

## 🔧 Environment Variables

Create a `.env` file with:

```env
# Server
API_PORT=3001
NODE_ENV=development

# Database (TODO)
DATABASE_URL=mongodb+srv://your-connection-string

# AI Services (TODO)
OPENAI_API_KEY=sk-your-openai-key
GOOGLE_API_KEY=your-google-ai-key

# Vector Database (TODO)
PINECONE_API_KEY=your-pinecone-key
PINECONE_INDEX_NAME=creator-transcripts-v2

# YouTube API (TODO)
YOUTUBE_API_KEY=your-youtube-api-key

# Security
BETTER_AUTH_SECRET=your-secret-key
TRUSTED_ORIGINS=http://localhost:3000,https://your-frontend.vercel.app
```

## 🛠️ Development Commands

```bash
# Development with hot reload
bun run dev

# Production build
bun run build

# Linting and formatting
bun run lint
bun run lint:fix
bun run format

# Type checking
bun run typecheck

# Testing
bun run test
```

## 🚢 Deployment

### Railway
1. Connect your GitHub repo to Railway
2. Set environment variables in Railway dashboard
3. Deploy automatically on push

### Docker
```bash
# Build image
docker build -t yt-channel-ai-processor .

# Run container
docker run -p 3001:3001 --env-file .env yt-channel-ai-processor
```

## 🎯 Next Steps

This is a **clean foundation** ready for you to add:

1. **Database Integration** - MongoDB connection and models
2. **AI Services** - OpenAI, Google AI, Pinecone integration
3. **RAG Pipeline** - Semantic search and context building
4. **Authentication** - API key or JWT-based auth
5. **Rate Limiting** - Request throttling and quota management
6. **Caching** - Redis for performance optimization

## 📊 Performance

Built with Bun and Hono for optimal performance:
- **Fast Cold Starts**: ~500ms vs 2-3s (Node.js)
- **Low Memory**: ~75MB vs 150MB (Node.js)
- **High Throughput**: Native performance for API workloads

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Run linting and type checking
6. Submit a pull request

---

**Built with ❤️ using Hono + Bun**