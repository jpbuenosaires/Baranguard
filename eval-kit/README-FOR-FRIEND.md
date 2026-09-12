# Baranguard AI evaluation — thank you for helping with this!

This folder measures how well a local AI model removes personal
information (names, addresses, phone numbers, etc.) from 200 made-up
sample incident reports. Every single report in here is fictional —
invented specifically for this test, never a real complaint from anyone.
Nothing in this folder is private or sensitive.

Your computer never sends anything anywhere. Everything runs entirely on
your own machine, offline. When it's done, you send back two small text
files — that's it.

## Before you start — two things to install

**1. Ollama** (the program that runs the AI model locally)
- Download and install from: https://ollama.com/download
- Then open Command Prompt (search "cmd" in the Start menu) and run:
  ```
  ollama pull aisingapore/Llama-SEA-LION-v3.5-8B-R
  ```
  This downloads the model (a few gigabytes — it'll take a while on a
  normal connection). Only needs to be done once.

**2. PHP** (the language this tool is written in)
- Easiest way on Windows: open Command Prompt and run
  `winget install PHP.PHP`
- Or download manually from https://windows.php.net/download/ (get the
  "Non Thread Safe" zip, unzip it anywhere, and add that folder to your
  PATH — ask if this step is confusing, it's the fiddliest part).

## Running it

1. Double-click **`run-evaluation.bat`** in this folder.
2. The first time, it will create a `.env` file for you and ask you to
   check it, then stop. Just open `.env` in Notepad, confirm the model
   name matches exactly what you `ollama pull`-ed, save, and run the
   `.bat` again.
3. It runs a tiny 3-record test first (a minute or two) to make sure
   everything is set up right before committing to the full run.
4. Then it runs the real 200-record test. **This takes a while — could be
   several hours, possibly longer on an older machine.** That's expected,
   not a hang: a real test of this same tool on the project's own
   CPU-only dev machine took more than 5 minutes for a single record. It
   automatically pauses for a couple of minutes every 20 records to give
   your CPU a breather — you'll see "resting..." messages, that's normal
   too.
5. **You can safely close the window at any point** (need your computer
   for something else, going to bed, whatever). Just double-click
   `run-evaluation.bat` again later — it remembers exactly where it left
   off and continues from there. It will never redo work or lose progress.
6. When it finishes, it prints exactly which files to send back — look
   for `evaluation-results-*.txt` and `evaluation-log-*.txt` in this
   folder. Just send those two files back (email, chat, whatever's easy).

## Is my computer okay to run this on?

Yes — this only uses the CPU and won't damage anything, it just takes a
while and keeps the computer a bit busy in the background. If your laptop
runs hot or the fan gets loud, that's normal for a long AI job — the
built-in rest pauses help with that. Feel free to close it and resume
later if you'd rather not leave it running overnight.

## If something goes wrong

The `.bat` file tries to explain what's wrong and what to do about it
(e.g. "Ollama isn't running" or "PHP isn't installed"). If you're stuck,
just send a screenshot of the message back and we'll sort it out — you
haven't broken anything either way.

Thank you again for helping with this!
