---
audience: "the maintainer choosing where to announce worktree-control 0.1.0"
last_reviewed: "2026-10-05"
source_of_truth: "draft announcement text and candidate channels for the 0.1.0 release"
status: "active"
---

# Release announcement draft: worktree-control 0.1.0

Drafts only. Nothing here has been posted. The owner chooses one channel, edits
the text, and records the date and channel in the market-test task.

## English post

Title: worktree-control 0.1.0: one dev port per project, shared with your coding agents

With several Git worktrees per project and Claude Code or Codex sessions running
in parallel, dev servers collide on ports and agents can restart each other's
servers. worktree-control is a local controller that keeps one managed dev
server per project on a stable port and moves it between worktrees.

- Agents claim a project over MCP, start or switch the server, and release the
  claim. Humans can lock a worktree. It only stops process trees it started.
- A test queue runs presets per worktree and shows which commit and local
  changes a result applies to.
- A built-in backlog, discussions and memory give the next agent session context.

It runs on your machine (browser dashboard, CLI, MCP, SQLite), is MIT licensed
and needs no account. Linux x64 is verified; macOS and Windows are not. It is
pre-1.0, so expect rough edges.

    npm install --global worktree-control

https://github.com/pioootrek/worktree-control

I would like to hear where setup or the agent workflow breaks for you. It is
unrelated to the npm package named worktree-switcher.

## Polish variant

worktree-control 0.1.0: lokalny kontroler, który trzyma jeden serwer dev na stałym porcie i przełącza go między worktree Gita; agenci (MCP) rezerwują projekt i uruchamiają testy w kolejce. MIT, Linux x64 zweryfikowany, wersja przed 1.0: `npm install --global worktree-control`.
Szukam opinii, gdzie konfiguracja lub praca z agentem się psuje: https://github.com/pioootrek/worktree-control

## Candidate channels

1. Claude Code GitHub Discussions (anthropics/claude-code): reaches people who
   already configure MCP servers and skills for Claude Code, but check the
   category rules first because promotional posts may be unwelcome.
2. r/ClaudeAI: a large audience of Claude Code users who discuss parallel
   worktree workflows; read the subreddit's self-promotion rules and label the
   post as a project you made.
3. Hacker News "Show HN": a technical audience that tries tools and gives blunt
   feedback, and the linked repository must be usable at once, which holds
   after publication; a post needs a first-hand, non-marketing description.
