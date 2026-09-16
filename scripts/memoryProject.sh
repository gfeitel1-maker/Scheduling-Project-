#!/bin/zsh
# The ONE place the live memory store's location is written down (T171 item 4).
#
# The consolidation move's stated point was "works from any checkout". The SCRIPTS
# half became portable via ${0:A:h}; the DATA half stayed one person's home
# directory literal, repeated across five files. The claim and the code disagreed.
#
# THE DATA PATH IS NOT DERIVABLE, and that is why this is a constant rather than a
# computation. Claude Code names a project directory after the path the session was
# STARTED from, and this memory store is named after a directory that no longer
# holds the repo (~/Desktop/Camp App System/...). It is a live store that must not
# move — run.sh's own comment says so — so the slug cannot be inferred from the
# repo's location, today or ever.
#
# What it CAN be is written once and overridable. Set SHORESH_MEMORY_PROJECT to
# point the pipeline at a different project directory (another machine, another
# user, a test fixture); leave it unset and the default below is used, which is the
# behaviour every caller had before this file existed.
: "${SHORESH_MEMORY_PROJECT:=-Users-gregfeitel-Desktop-Camp-App-System--Applications-Schedule-Project}"

MEMORY_PROJECT_SLUG="$SHORESH_MEMORY_PROJECT"
MEMORY_PROJ="$HOME/.claude/projects/$MEMORY_PROJECT_SLUG"
MEMORY_CONS="$MEMORY_PROJ/_consolidation"
MEMORY_DIR="$MEMORY_PROJ/memory"
