# Voxel Rampage

Open-arena 3D pixel shooter that runs in the browser. Bots come in waves: red grunts rush you, violet shooters fire from range. Headshots score double.

Players can connect a Solana wallet (Phantom, Solflare, Backpack) and post their best score to a shared leaderboard. Posting is a free message signature and sends no transaction.

## Run locally

```
npm start
```

Then open http://localhost:3000. There are no dependencies to install.

## How the leaderboard works

- `POST /api/start` opens a game session when a round starts.
- `POST /api/score` takes the score, the wallet address and a signature of the score message. The server checks the ed25519 signature, allows one submission per session, and rejects scores that couldn't be reached in the time played.
- `GET /api/leaderboard` returns the top 50, one best score per wallet.

Scores are stored in `leaderboard.json` inside `DATA_DIR` (defaults to `./data`). On Railway, mount a volume at `/data` and set `DATA_DIR=/data`.

## Controls

WASD to move, mouse to aim, click to shoot, Space to jump, Shift to sprint, R to reload, Esc to pause. Phones get an on-screen joystick and buttons.
