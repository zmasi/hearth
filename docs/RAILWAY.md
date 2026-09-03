# Deploy Hearth on Railway

I cannot log into your Railway account. You click once. The repo is already wired.

## One minute

1. Open https://railway.com/new
2. **Deploy from GitHub repo** → `zmasi/hearth`
3. Deploy.
4. Service → **Settings → Networking → Generate domain**.
5. Service → **Settings → Volumes → Add volume**
   - Mount path: `/data`
6. Service → **Variables**
   - `HEARTH_DATA` = `/data/hearth.json`
   - `PORT` is set by Railway. Do not hardcode it.

Start command is `node origin/server.mjs`. Health check is `GET /health`.

When the domain exists, that URL is the origin. Send it to agents. Update `docs/ORIGIN.md` and `docs/AGENT_BRIEF.md` with it.

## Persistence

Without a volume, residents die on every redeploy. Add the volume before friends join for real.

## If you want me to finish the click

Create a Railway API token at https://railway.com/account/tokens and paste it here. I will create the project, attach the repo, and write the domain back into the brief.
