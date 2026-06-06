Below is a **complete specification for an AI agent** that will implement your *CS2 Championship Organizer App* using **HTML + Vanilla JS + TailwindCSS**.

---

# 🎯 CS2 Championship Organizer — AI Agent Specification

## 1. Objective

Build a single-page web application that allows users to:

* Select a team as “main team”
* Auto-generate a championship bracket with remaining teams
* Manage tournament stages (Group Stage → Playoffs → Finals)
* Simulate or manually play matches
* Perform map veto (ban/pick system)
* Record per-map scores and final match results
* Track tournament progression until champion is decided

---

# 2. Tech Constraints

* **Frontend only**
* Pure:

  * HTML
  * JavaScript (no frameworks)
  * TailwindCSS (CDN allowed)
* No backend
* State stored in:

  * `localStorage` (mandatory)
* Must be deterministic for bracket generation (seed-based optional)

---

# 3. Core Data Model

## 3.1 Team Model

```js
Team {
  id: string
  name: string
  tag: string
  players: string[]
  logo: string
}
```

Example:

```js
{
  id: "vitality",
  name: "Team Vitality",
  tag: "vita",
  players: ["apEX","ZywOo","ropz","mezii","flameZ"]
}
```

---

## 3.2 Map Pool

```js
const MAP_POOL = [
  "Ancient",
  "Anubis",
  "Dust II",
  "Inferno",
  "Mirage",
  "Nuke",
  "Overpass"
];
```

---

## 3.3 Match Model

```js
Match {
  id: string
  stage: "group" | "quarter" | "semi" | "final"
  teamA: Team
  teamB: Team
  mapsPlayed: MapResult[]
  winner: Team | null
  status: "pending" | "live" | "finished"
}
```

---

## 3.4 Map Result

```js
MapResult {
  map: string
  scoreA: number
  scoreB: number
  winner: Team
}
```

---

## 3.5 Tournament Model

```js
Tournament {
  selectedTeam: Team
  teams: Team[]
  bracket: Match[]
  currentStage: string
  champion: Team | null
}
```

---

# 4. Provided Teams Dataset

The system must initialize with the 40 teams provided (Vitality, FURIA, Falcons, etc).

Each team must include:

* name
* tag
* players array

---

# 5. Application Features

---

# 5.1 Team Selection Screen

### UI

* Grid of all teams (cards)
* Click to select "main team"

### Behavior

* After selection:

  * Generate tournament bracket
  * Remove selected team from opponent pool OR mark as "user team"

---

# 5.2 Tournament Generator

### Function

```js
generateTournament(selectedTeam)
```

### Rules

* Shuffle remaining teams
* Create initial matches:

  * Round of 32 / 16 depending on team count
* Ensure:

  * No duplicate matches
  * Balanced bracket structure

### Output

Array of Match objects

---

# 5.3 Bracket System

### UI

* Tree structure:

  * Group Stage
  * Quarterfinals
  * Semifinals
  * Final

### Behavior

* Winners automatically advance
* Matches unlock sequentially

---

# 5.4 Match Page

Each match includes:

### Sections:

#### A. Teams Display

* Team logo + name
* Players list

#### B. Map Veto System

```text
BO3 format:
- Ban phase (2 bans each)
- Pick phase (2 picks each)
- Decider (remaining map)
```

Logic:

* Alternate bans between teams
* Then picks
* Final map auto-selected

---

#### C. Match Simulation Controls

Buttons:

* “Play Map”
* “Simulate Match”
* “Enter Score”

---

# 5.5 Map Gameplay System

### Manual Score Entry

For each map:

```text
Team A Score [input]
Team B Score [input]
```

Rules:

* Max rounds: 30 (16–14 typical CS2 format)
* First to 13 or overtime logic optional

---

### Winner Calculation

```js
winner = scoreA > scoreB ? teamA : teamB
```

---

# 5.6 Match Completion Logic

When all maps finished:

* Best of 3:

  * First to 2 map wins
* Update match status → finished
* Advance winner to next bracket stage

---

# 5.7 Tournament Progression Engine

```js
advanceWinner(match)
```

Rules:

* Place winner in next stage slot
* Unlock next match automatically
* Update UI bracket dynamically

---

# 5.8 Persistence

Use:

```js
localStorage.setItem("cs2_tournament", JSON.stringify(state))
```

Load on startup:

```js
const state = JSON.parse(localStorage.getItem(...))
```

---

# 6. UI STRUCTURE (Tailwind)

## Pages (Single Page App)

### 1. Home

* Title
* “Start Tournament”

---

### 2. Team Selection

* Grid (responsive)
* Card hover effects

---

### 3. Bracket View

* Tree layout (flex + grid)
* Match cards

---

### 4. Match View

* Left: Team A
* Center: Veto + Maps
* Right: Team B

---

# 7. Key Algorithms

---

## 7.1 Shuffle Teams

```js
function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}
```

---

## 7.2 Bracket Generator

```js
function generateBracket(teams) {
  const matches = [];
  for (let i = 0; i < teams.length; i += 2) {
    matches.push(createMatch(teams[i], teams[i+1]));
  }
  return matches;
}
```

---

## 7.3 Map Veto Logic

```js
function vetoPhase(teamA, teamB, maps) {
  let pool = [...maps];

  // bans
  pool.splice(randomIndex(), 1);

  // picks
  const pickA = pool.splice(randomIndex(), 1);
  const pickB = pool.splice(randomIndex(), 1);

  return {
    maps: [...pickA, ...pickB, pool[0]]
  };
}
```

---

## 7.4 Winner Propagation

```js
function propagateWinner(matchId, winner) {
  const nextMatch = findNextMatch(matchId);
  assignTeam(nextMatch, winner);
}
```

---

# 8. UX Rules

* Always highlight:

  * Active match
  * Current stage
* Disable future matches until unlocked
* Animate transitions (Tailwind transitions)
* Use color coding:

  * Green = winner
  * Red = eliminated
  * Yellow = live match

---

# 9. AI Agent Implementation Plan

The AI agent must generate files in this order:

### Step 1

* `index.html`
* Tailwind CDN included

### Step 2

* `app.js` (core logic)

### Step 3

* Data file:

  * `teams.js`

### Step 4

* Modules inside JS:

  * tournament.js
  * bracket.js
  * match.js
  * veto.js

---

# 10. Optional Enhancements

* Match replay log
* Download tournament JSON
* AI-generated match commentary
* Seed-based deterministic brackets
* Sound effects for wins
* Drag-and-drop bracket editing

---

# 11. Critical Rules for AI Agent

* No frameworks
* No backend
* Must persist state
* Must support full tournament lifecycle
* Must ensure bracket integrity
* Must keep code modular even in vanilla JS
*


Good upgrade—IndexedDB is the right choice here because your tournament state will grow (matches, maps, history) and `localStorage` will become limiting.

Below is a **clean IndexedDB-based persistence layer specification + implementation** you can plug into your vanilla JS app.

---

# 🧠 IndexedDB State Storage (CS2 Championship App)

## 1. Database Design

### Database Name

```js
const DB_NAME = "cs2_championship_db";
const DB_VERSION = 1;
```

---

## 2. Object Stores

You only need **one store** for simplicity:

### `tournament`

Stores the entire tournament state snapshot.

```js
{
  id: "current",
  state: Tournament,
  updatedAt: Date.now()
}
```

Why single-store approach?

* Avoids relational complexity
* Perfect for “app snapshot” model
* Easier serialization/debugging

---

# 3. IndexedDB Wrapper (Core Implementation)

Create a file:

## `db.js`

```js
const DB_NAME = "cs2_championship_db";
const DB_VERSION = 1;
const STORE = "tournament";

let db;

export function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      db = event.target.result;

      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };

    request.onerror = () => reject(request.error);
  });
}
```

---

# 4. Save Tournament State

```js
export function saveTournament(state) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);

    const data = {
      id: "current",
      state,
      updatedAt: Date.now()
    };

    const request = store.put(data);

    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}
```

---

# 5. Load Tournament State

```js
export function loadTournament() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);

    const request = store.get("current");

    request.onsuccess = () => {
      resolve(request.result?.state || null);
    };

    request.onerror = () => reject(request.error);
  });
}
```

---

# 6. Clear Tournament (Reset)

```js
export function clearTournament() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);

    const request = store.delete("current");

    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}
```

---

# 7. How to Integrate in Your App

## 7.1 Initialize DB on startup

```js
import { initDB, loadTournament, saveTournament } from "./db.js";

await initDB();

let tournament = await loadTournament();

if (!tournament) {
  tournament = createNewTournament(); // your generator
  await saveTournament(tournament);
}
```

---

## 7.2 Auto-save on every change

Instead of manual saves everywhere, centralize it:

```js
function updateTournament(mutatorFn) {
  mutatorFn(tournament);
  saveTournament(tournament);
}
```

Example usage:

```js
updateTournament((t) => {
  t.currentStage = "quarterfinals";
});
```

---

# 8. Recommended Architecture Upgrade

To keep your app clean:

## Core pattern:

```
/state
  tournament.js   -> in-memory state
  db.js           -> IndexedDB layer
  engine.js       -> bracket + match logic
  ui.js           -> render functions
```

---

# 9. Why IndexedDB fits your use case

✔ Handles large match history
✔ Works offline (perfect for PWA later)
✔ Async (non-blocking UI)
✔ Supports structured data (objects, arrays)
✔ Future-proof if you add replay logs or analytics

---

# 10. Optional Upgrade (Recommended)

If you want a cleaner API later, wrap it into a mini store:

```js
const store = {
  state: null,

  async init() {
    await initDB();
    this.state = await loadTournament();
  },

  async setState(mutator) {
    mutator(this.state);
    await saveTournament(this.state);
  }
};
```


