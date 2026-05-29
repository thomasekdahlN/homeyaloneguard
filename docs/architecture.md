Dette er et spennende utviklingsprosjekt! For å implementere **McCallister Guard** på dagens Homey-plattform (Homey Pro 2023 og nyere firmware), må vi bygge appen etter **Homey Apps SDK v3**-standarden.

Siden appen skal kontrollere enheter *dynamisk på tvers av soner* uten at brukeren må lage 100 manuelle flows, må vi bruke **Homey Web API** internt i appen. Dette gir appen full tilgang til å se hvilke enheter (lys, høyttalere, kameraer) som befinner seg i de ulike rommene.

Her er utkastet til den tekniske arkitekturen.

---

## 1. Teknologisk Stack & Versjoner

* **Runtime:** Node.js v16+ (Homey Pro-runtime, target satt via `@tsconfig/node16`).
* **Språk:** **TypeScript** (kompilert til JS via `tsc`).
* **SDK Versjon:** Homey Apps SDK v3 (`@types/homey` → `homey-apps-sdk-v3-types`).
* **Utviklingsverktøy:** `homey` CLI (Athom, installert globalt) — brukes til `homey app create | validate | run | install | publish`.
* **Linting:** ESLint med `eslint-config-athom`.
* **CI/CD:** GitHub Actions workflows lagt til av wizarden:
  * `.github/workflows/homey-app-validate.yml` — validerer ved push/PR
  * `.github/workflows/homey-app-version.yml` — bumper versjon
  * `.github/workflows/homey-app-publish.yml` — publiserer til Athom App Store
  * Krever `HOMEY_PAT` secret i GitHub-repo (hentes fra https://tools.developer.homey.app/me).
* **Dependencies (NPM):**
  * `homey-api` — programmatisk tilgang til alle enheter, soner og kapasiteter i Homey.
* **DevDependencies (NPM):**
  * `typescript`, `@tsconfig/node16`, `@types/node`, `@types/homey` (alias for `homey-apps-sdk-v3-types`)
  * `eslint`, `eslint-config-athom`



---

## 2. Prosjektstruktur (Directory Tree)

Appen er scaffoldet med `homey app create` og ligger i undermappen `com.mccallister.guard/` (workspace-relativt). Faktisk struktur:

```text
McAllisterAlarm/                       # workspace-rot
├── spesification.md
├── architecture.md
└── com.mccallister.guard/             # Homey-appen
    ├── app.json                       # GENERERT — ikke editér direkte
    ├── app.ts                         # Hovedinngang og livssyklus (Lifecycle)
    ├── package.json
    ├── tsconfig.json
    ├── README.txt
    ├── LICENSE
    ├── .homeycompose/                 # KILDEN til app.json (modulær config)
    │   ├── app.json
    │   ├── flow/                      # Triggere, betingelser, handlinger
    │   ├── drivers/
    │   ├── capabilities/
    │   ├── signals/
    │   ├── discovery/
    │   └── screensavers/
    ├── lib/                           # (opprettes ved implementasjon)
    │   ├── StateMachine.ts            # Tilstander (Borte, Natt, Alarm, Krise)
    │   ├── SimulationEngine.ts        # Kevin-modus
    │   ├── DeterrenceEngine.ts        # Sone-mapping og reaktiv avskrekking
    │   ├── CameraManager.ts           # Snapshot-loop (5s) og varsling
    │   ├── EventLog.ts                # Persistent logg (150 hendelser)
    │   └── LightAuthGuard.ts          # Modul 5: uautorisert lys-av
    ├── api.ts                         # REST API-endepunkter for Dashboardet
    ├── settings/
    │   └── index.html                 # Dashboard UI (Soneoversikt, logg, config)
    ├── assets/
    │   ├── icon.svg
    │   ├── images/                    # small/large/xlarge.png
    │   └── media/                     # blue-lights.mp4, police-siren.mp3
    ├── locales/
    │   ├── en.json
    │   └── no.json                    # legges til ved implementasjon
    └── .github/workflows/
        ├── homey-app-validate.yml
        ├── homey-app-version.yml
        └── homey-app-publish.yml
```

---

## 3. App Manifest (`app.json` via `.homeycompose/`)

`app.json` i rotmappa er **generert** av `homey app build`/`homey app run`. Kilden ligger i `.homeycompose/app.json` samt undermappene `flow/`, `drivers/`, `capabilities/` osv. Flow-kort legges som separate filer i `.homeycompose/flow/{triggers,conditions,actions}/<id>.json`.

Eksempel `.homeycompose/app.json`:

```json
{
  "id": "com.mccallister.guard",
  "sdk": 3,
  "name": { "en": "McCallister Guard", "no": "McCallister Guard" },
  "description": { "en": "Kevin-modus inspirert sikkerhetssystem for Homey", "no": "Kevin-modus inspirert sikkerhetssystem for Homey" },
  "version": "1.0.0",
  "compatibility": ">=12.4.0",
  "runtime": "nodejs",
  "platforms": ["local"],
  "category": ["security"],
  "permissions": [
    "homey:manager:api"
  ],
  "images": {
    "small": "/assets/images/small.png",
    "large": "/assets/images/large.png",
    "xlarge": "/assets/images/xlarge.png"
  },
  "author": { "name": "Thomas Ekdahl", "email": "thomas@ekdahl.no" }
}
```

Eksempel `.homeycompose/flow/actions/set_mode.json`:

```json
{
  "id": "set_mode",
  "title": { "no": "Sett McCallister modus til [[mode]]", "en": "Set McCallister mode to [[mode]]" },
  "args": [
    {
      "name": "mode",
      "type": "dropdown",
      "values": [
        { "id": "disarmed",   "label": { "no": "Deaktivert",       "en": "Disarmed" } },
        { "id": "armed_away", "label": { "no": "Borte (Alarm På)", "en": "Armed Away" } },
        { "id": "armed_stay", "label": { "no": "Nattmodus",         "en": "Armed Stay" } }
      ]
    }
  ]
}
```

Eksempel `.homeycompose/flow/triggers/deterrence_started.json`:

```json
{
  "id": "deterrence_started",
  "title": { "no": "Avskrekking startet i sone [[zone]]", "en": "Deterrence started in zone [[zone]]" },
  "tokens": [
    { "name": "zone", "type": "string", "title": { "no": "Sone", "en": "Zone" } }
  ]
}
```

---

## 4. Kjernekomponenter

### 4.0. Tilstandsmaskin (5-modus)

McCallister Guard bruker en strikt tilstandsmaskin med fem modi. Alle overganger valideres mot `VALID_TRANSITIONS`-tabellen i `lib/types.ts`.

```
Mode = 'disarmed' | 'armed_away' | 'armed_stay' | 'deterrence' | 'alarm'
```

**Tillatte overganger:**

```
disarmed    → armed_away, armed_stay, deterrence*, alarm*
armed_away  → disarmed, deterrence, alarm
armed_stay  → disarmed, armed_away, deterrence, alarm
deterrence  → alarm, armed_stay, armed_away, disarmed
alarm       → armed_stay, armed_away, disarmed

* = kun fra test-knapp/flow, ikke fra bruker-dashboard
```

**Normalt sensorforløp:**
```
armed_stay / armed_away
    │ (sensor utløses)
    ▼
deterrence  ──── reaksjonssone-blink (DeterrenceEngine)
    │ (escalation_minutes timer)
    ▼
alarm       ──── full-hus strobe + sirener (EscalationManager)
    │ (bruker trykker Stopp, eller stopAlarm())
    ▼
armed_stay / armed_away  (forrige modus gjenopprettes automatisk)
```

**Stopp alarm:**
`stopAlarm()` i `app.ts` lagrer `previousArmedMode` når systemet går inn i `deterrence`, og gjenoppretter denne ved stopp — uten å gå via `disarmed`.

### 4.1. Hovedmotoren: `app.ts`

Initialiserer appen, kobler seg til Homey API-en og lytter på globale bevegelsessensorer. Sentrale private metoder:

| Metode | Ansvar |
|---|---|
| `enterDeterrence()` | Setter modus=deterrence, starter blink i reaksjonssone og starter `deterrenceTimer` |
| `enterAlarm()` | Kaller `EscalationManager.triggerCrisis()` og setter modus=alarm |
| `clearDeterrenceTimer()` | Avbryter eskaleringstimeren (kalles fra `setMode('disarmed')`, `stopAlarm()`, test-metoder) |
| `setMode()` | Brukerinitiiert modusbytte — rydder alltid timere og media ved disarmed |
| `stopAlarm()` | Stopper pågående alarm og returnerer til `previousArmedMode` |

### 4.2. Logikkmotoren for "Mind-games": `lib/DeterrenceEngine.ts`

Håndterer svingningene mellom sonene. Blålys-effekten castes fra lokal asset (`/assets/media/blue-lights.mp4`) eller faller tilbake til blinkende blå smartpærer hvis ingen skjerm finnes i sonen (se §6.1 i spec).

```typescript
import type McCallisterApp from '../app';

export default class DeterrenceEngine {
  private activeDeterrenceZone: string | null = null;
  private cooldownTimer: NodeJS.Timeout | null = null;

  constructor(private readonly app: McCallisterApp) {}

  async handleMotion(zoneId: string, deviceId: string): Promise<void> {
    const mode = this.app.stateMachine.getMode();
    if (mode === 'disarmed') return;

    this.app.log(`Bevegelse registrert i sone: ${zoneId}`);

    if (zoneId === this.activeDeterrenceZone) {
      this.abortCurrentDeterrence();
      const delay = (this.app.homey.settings.get('deterrence_delay') as number) ?? 15;
      this.cooldownTimer = setTimeout(() => {
        // velg ny reaksjonssone basert på matrisen for zoneId
        const matrix = (this.app.homey.settings.get('zone_matrix') as Record<string, string>) || {};
        const next = matrix[zoneId];
        if (next) this.executeDeterrence(next);
      }, delay * 1000);
      return;
    }

    const matrix = (this.app.homey.settings.get('zone_matrix') as Record<string, string>) || {};
    const reactionZoneId = matrix[zoneId];
    if (reactionZoneId) await this.executeDeterrence(reactionZoneId);
  }

  private async executeDeterrence(zoneId: string): Promise<void> {
    this.activeDeterrenceZone = zoneId;
    this.app.log(`Aktiverer avskrekking i reaksjonssone: ${zoneId}`);

    const devices = await this.app.homeyApi.devices.getDevices();
    const zoneDevices = Object.values(devices).filter((d) => d.zone === zoneId);

    for (const device of zoneDevices) {
      if (device.capabilities.includes('onoff') && !device.capabilities.includes('alarm_motion')) {
        await device.setCapabilityValue('onoff', true).catch(() => {});
      }
      // Cast av blue-lights.mp4 / fallback til blinkende lys håndteres i egen MediaCaster-modul.
    }
  }

  private abortCurrentDeterrence(): void {
    if (!this.activeDeterrenceZone) return;
    this.app.log(`Mørklegger sone ${this.activeDeterrenceZone} umiddelbart!`);
    this.activeDeterrenceZone = null;
  }
}

module.exports = DeterrenceEngine;
```

---

## 5. Kommunikasjon og Dashboard API (`api.ts`)

For at Dashboardet (HTML-siden) skal vite status på sonene i sanntid, eksponerer vi et internt API. Endepunktene registreres i `.homeycompose/app.json` under `api`-feltet.

```typescript
import type McCallisterApp from './app';
import type { Mode } from './app';

interface ApiCtx { homey: { app: McCallisterApp } }
interface SetModeBody { mode: Mode }

module.exports = {
  async getStatus({ homey }: ApiCtx) {
    return {
      mode: homey.app.stateMachine.getMode(),
      activeDeterrenceZone: homey.app.deterrenceEngine.getActiveZone(),
      log: homey.app.stateMachine.getRecentLogs(),
    };
  },

  async setMode({ homey, body }: ApiCtx & { body: SetModeBody }) {
    await homey.app.stateMachine.setMode(body.mode);
    return { success: true };
  },
};
```

---

## 6. Soneoversikt & Dashboard (Frontend: `settings/index.html`)

Homey bruker standard HTML/JS for app-innstillinger og tilpassede skjermbilder. Vi bruker `Homey.api` i frontenden for å snakke med `api.ts`.

```html
<!DOCTYPE html>
<html>
<head>
  <script type="text/javascript" src="/homey.js" id="homey-api"></script>
  <style>
    .zone-list { display: flex; flex-direction: column; gap: 10px; }
    .zone-card { padding: 15px; border-radius: 8px; background: #f0f0f0; display: flex; justify-content: space-between; }
    .status-active { background: #ff4d4d; color: white; } /* Rød */
    .status-deter { background: #3399ff; color: white; }  /* Blå */
    .status-normal { background: #2ecc71; color: white; } /* Grønn */
  </style>
</head>
<body>
  <h2>McCallister Guard Dashboard</h2>
  <div id="mode-status">Laster status...</div>
  
  <h3>Soneovervåking</h3>
  <div id="zones" class="zone-list"></div>

  <script>
    function onHomeyReady(Homey) {
      Homey.ready();
      
      // Polling eller WebSockets for å oppdatere UI i sanntid
      setInterval(async () => {
        const status = await Homey.api('GET', '/getStatus');
        document.getElementById('mode-status').innerText = "Modus: " + status.mode;
        
        // Logikk for å tegne opp sonene (rød, blå eller grønn) basert på status
        renderZones(status);
      }, 2000);
    }
  </script>
</body>
</html>

```

---

## 7. Utviklings-workflow (CLI)

* `homey app run` — kjør appen lokalt mot tilkoblet Homey Pro
* `homey app validate` — valider `app.json`, flow-kort, assets
* `homey app validate --level publish` — strenge sjekker før publisering
* `homey app install` — installer på Homey Pro
* `npm run build` — TypeScript-kompilering
* `npm run lint` — ESLint
* GitHub Actions kjører `homey app validate` ved push/PR automatisk.

---

## Hvorfor denne arkitekturen er robust:

1. **Sentralisert logikk:** Ved å overvåke *alle* enheter fra `app.ts` slipper brukeren å bygge komplekse Flows for hvert enkelt rom. Appen finner automatisk ut hvilket lys som er hvor.
2. **Asynkron håndtering:** Node.js håndterer I/O-kommandoer asynkront. Det betyr at mørklegging av ett rom og tenning i et annet skjer tilnærmet momentant (< 200ms), noe som er kritisk for å lure tyven.
3. **Frakoblet sikkerhet:** Siden appen bruker `HomeyAPI.createLocalAPI()`, kjører all logikk og bildebehandling lokalt på Homey Pro-enheten. Systemet fungerer med andre ord selv om internettlinjen skulle gå ned under et innbrudd.
4. **Type-sikkerhet:** TypeScript fanger feil ved kompilering — kritisk for en alarmapp der "udefinerte" feil i en avskrekkingssekvens kan ødelegge hele effekten.