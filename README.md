# News

## Setup

```bash
npm install
cp .env.example .env   # fill in your values
```

## Environment Variables

Create a `.env` file based on `.env.example`:

| Variable | Description |
|---|---|
| `MONGO_URI` | MongoDB connection string (local or Atlas) |
| `JWT_SECRET` | Long random string for signing JWTs |
| `PORT` | Server port (default: `3000`) |
| `NODE_ENV` | `development` or `production` |
| `OPENAI_API_KEY` | [OpenAI](https://platform.openai.com/api-keys) — article analysis |
| `NEWSAPI_KEY` | [NewsAPI.org](https://newsapi.org) |
| `NEWSAPI_AI_KEY` | [NewsAPI.ai](https://www.newsapi.ai) |
| `WEBZ_KEY` | [Webz.io](https://webz.io) |
| `WORLDNEWS_KEY` | [WorldNewsAPI](https://worldnewsapi.com) |
| `NEWSDATA_KEY` | [NewsData.io](https://newsdata.io) |
| `THENEWSAPI_KEY` | [TheNewsAPI](https://www.thenewsapi.com) |

### MongoDB

**Local:** `MONGO_URI=mongodb://127.0.0.1:27017/news`

**Atlas (cloud):**
1. Create a free cluster at [mongodb.com/atlas](https://www.mongodb.com/atlas)
2. Add your IP under **Network Access**
3. Create a DB user under **Database Access**
4. Copy the connection string from **Connect → Drivers**

```
MONGO_URI=mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/news
```

## Run

```bash
# Development
npm run dev

# Production
npm start
```

Open **http://localhost:3000**
