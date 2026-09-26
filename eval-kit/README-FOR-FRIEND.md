# Baranguard AI evaluation — thank you for helping with this!

This folder measures how well a local AI model removes personal
information (names, addresses, phone numbers, etc.) from 350 made-up
sample incident reports. Every single report in here is fictional —
invented specifically for this test, never a real complaint from anyone.
Nothing in this folder is private or sensitive.

(If you ran an earlier version of this kit before: it used to test 200
reports in 3 languages. It's now 350 reports across 7 language
combinations — including reports that mix Bikol, Tagalog, and English in
the same report, since that's how people actually write in real life.)

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
4. Then it runs the real 350-record test. **This takes a while — could be
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

## The other 3 things this AI model does (optional, and a bigger ask)

The double-click `run-evaluation.bat` only tests ONE thing — redaction
(removing personal info) — because it's the most important one and the
one most worth everyone's patience. The same AI model also writes case
summaries, translates records, and pulls out complainant/respondent/
contact details.

**Only do this after `run-evaluation.bat` has finished at least its
first smoke test successfully** (it's what confirms PHP/Ollama are set
up right). Each of the 3 has its OWN double-click file, so you can do
them one at a time, in any order, whenever you have time — closing one
never affects the others:

- `run-evaluation-summary.bat`
- `run-evaluation-extraction.bat`
- `run-evaluation-translation.bat`

All three run against the same 350-record set redaction did, so expect
each one to take roughly as long as that run did. Same as before: safe
to close any of these windows at any point and double-click that SAME
file again later — it remembers exactly where that one task left off.
Each writes its own `evaluation-results-<task>-*.txt` /
`evaluation-log-<task>-*.txt` files when it finishes — send back
whichever ones you've run, alongside the main redaction files.

If you'd rather type the command yourself instead of double-clicking,
each `.bat` file's real command (run from inside this folder) is:

```
php scripts\ai-evaluate.php --task=summary --engine=model --dry-run --verbose --batch-size=20 --rest-seconds=120 --resume --save-results
php scripts\ai-evaluate.php --task=extraction --engine=model --dry-run --verbose --batch-size=20 --rest-seconds=120 --resume --save-results
php scripts\ai-evaluate.php --task=translation --translate-to=fil --engine=model --dry-run --verbose --batch-size=20 --rest-seconds=120 --resume --save-results
```

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
