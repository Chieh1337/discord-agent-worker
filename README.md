# Discord Agent Worker

GitHub Actions worker for the Discord AI bot. Receives `repository_dispatch` events from a Cloudflare Worker, fetches YouTube transcripts, calls Gemini for summarization, and PATCHes the result back to Discord.

## Architecture

```
[Discord] → [Cloudflare Worker]              ← signature verify, deferred ack
              ↓ POST /repos/.../dispatches
            [GitHub Action (this repo)]      ← actual work, GitHub IP not blocked
              ├── youtube-transcript        ← fetch transcript
              ├── Gemini API                ← summarize
              └── Discord webhook PATCH     ← deliver result
```

## Why?

YouTube actively blocks Cloudflare's datacenter IP ranges from accessing caption data (innertube returns 400, watch page returns 429, timedtext returns empty). Routing transcript fetches through GitHub Actions sidesteps the issue.

## Secrets needed

| Secret | Where used | Source |
|--------|-----------|--------|
| `GEMINI_API_KEY` | Action env | Google AI Studio |
| `DISCORD_BOT_TOKEN` | Action env | Discord developer portal |

Set via:

```bash
gh secret set GEMINI_API_KEY
gh secret set DISCORD_BOT_TOKEN
```

## Dispatch payload contract

The Cloudflare Worker POSTs to:

```
POST /repos/{owner}/{repo}/dispatches
{
  "event_type": "youtube",
  "client_payload": {
    "video_id": "abc123",
    "application_id": "1502...",
    "interaction_token": "aW50ZXJh..."
  }
}
```

The Action reads these via `${{ github.event.client_payload.* }}` and forwards them to the Node script as env vars.
