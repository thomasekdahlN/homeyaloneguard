Her er en komplett, strukturert og detaljert teknisk og funksjonell spesifikasjon for Homey-appen **"McCallister Guard"**. Dette dokumentet er klart til å overleveres til en utvikler eller brukes som veikart for koding.

---

# Teknisk og Funksjonell Spesifikasjon: McCallister Guard (Homey App)

## 1. Innledning og Formål

**McCallister Guard** er en avansert og utradisjonell sikkerhets-app for smarthussystemet Homey. Appen er inspirert av filmen *Alene Hjemme* (Home Alone). I stedet for bare å være et passivt alarmsystem som varsler etter at et innbrudd har skjedd, bruker appen psykologisk krigføring, avskrekking og "mind-games" for å skremme bort tyver *før* de gjør skade, samtidig som den gir huseieren full oversikt og bildedokumentasjon.

---

## 2. Systemarkitektur og Enhetsstøtte

Appen fungerer som en overordnet logikkmotor som koordinerer eksisterende enheter i Homey-økosystemet via standard Homey-kapasiteter (`capabilities`):

* **Sensorer (`alarm_motion`, `alarm_contact`):** Bevegelsessensorer og dør-/vinduskontakter.
* **Belysning (`onoff`, `dim`, `light_hue`):** Smartpærer og dimmere (f.eks. Philips Hue, IKEA Trådfri).
* **Mediespillere (`speaker_playing`, `chromecast`):** Høyttalere (Sonos, Google Home) og TV-er/skjermer (Chromecast, Android TV).
* **Kameraer (`homey:device:camera`):** Kameraer integrert i Homey som støtter snapshot-funksjonalitet (`image`).

---

## 3. Brukergrennesnitt (App UI Dashboard)

Appen skal ha et eget skjermbilde (Dashboard) i Homey-appen som gir sanntidsstatus over systemet:

### 3.1. Hovedkontroller (Øverst)

* **Statusvelger (Knapper):** `Deaktivert` | `Aktivert (Borte)` | `Aktivert (Natt)`.
* **Panikknapp (Panic Button):** En rød knapp som umiddelbart utløser full avskrekkingssekvens og eskalert alarm i hele huset, uavhengig av nåværende modus.

### 3.2. Soneoversikt (Midten)

En visuell liste over alle konfigurerte soner i huset med sanntids fargekoding:

* 🟢 **Grønn (Inaktiv):** Ingen bevegelse registrert, alt normalt.
* 🔴 **Rød (Detektert):** Sensoren i denne sonen har registrert bevegelse (tyvens nåværende posisjon).
* 🔵 **Blå (Avskrekking Aktiv):** Denne sonen kjører for øyeblikket "blålys og sivil status"-simuleringen (reaksjonssonen).

### 3.3. Hendelseslogg (Nederst)

En rullende logg som viser de siste 150 hendelsene i systemet (viktig for dokumentasjon og forsikring). Loggen lagres persistent i `Homey.ManagerSettings` slik at den overlever app-restart.

* *Eksempel:* `[2026-05-23 23:15:02] Alarm aktivert i Borte-modus.`
* *Eksempel:* `[2026-05-23 02:10:45] BEVEGELSE: Stue. Reaksjon startet på Hovedsoverom.`

---

## 4. Konfigurasjon og Globale Innstillinger (Settings)

### 4.1. Sone- og Reaksjonsmatrise

Brukeren kobler deteksjonssoner direkte til reaksjonssoner (rommet lengst unna) via rullegardiner i app-oppsettet. Matrisen baseres på brukerens egne Homey-soner (`zones`); appen forhåndsdefinerer ikke navngitte rom — brukeren mapper sine egne soner mot reaksjonssoner.

**Eksempeloppsett (kan endres):**

* Hvis bevegelse i **Entré/Gang** ➡️ Reaksjon i **Hovedsoverom (2. etasje)**
* Hvis bevegelse i **Stue (1. etasje)** ➡️ Reaksjon i **Gjesterom/Kontor (2. etasje)**
* Hvis bevegelse i **Kjøkken** ➡️ Reaksjon i **Kjellerstue / Garasje**
* Hvis bevegelse i **Bakgård/Terrasse** ➡️ Reaksjon i **Entré/Gang**
* Hvis bevegelse i **Hovedsoverom** ➡️ Reaksjon i **Kjellerstue**
* Hvis bevegelse i **Kjellerstue** ➡️ Reaksjon i **Hovedsoverom**

### 4.2. Globale Parametere

* `Bedtime` (Tidspunkt, default `23:30`): Når tilstedeværelsessimuleringen avsluttes.
* `Sunset Offset` (Minutter, default `-30`): Tid før/etter solnedgang simuleringen starter.
* `Random Min/Max` (Intervall, default `10 - 45 min`): Intervall for lysbytte i simulering.
* `Deterrence Delay` (Sekunder, default `15`): Stillhetstid før avskrekkingen flytter seg etter tyvens forflytning.
* `Exit Delay` (Sekunder, default `60`): Utpasseringsforsinkelse.
* `Entry Delay` (Sekunder, default `30`): Innpasseringsforsinkelse.
* `Escalation Time` (Minutter, default `5`): Hvor lenge kontinuerlig bevegelse må pågå før Krise-tilstand (Modul 3) utløses. Telles fra første deteksjon.
* `Custom Audio URL` (Tekstfelt): Valgfri HTTP/HTTPS-lenke til en privat `.mp3`-fil (f.eks. krangel/samtale). Appen har innebygd politisirene som fallback.
* `Kevin-modus Soner` (Multi-checkbox): For hver Homey-sone kan brukeren krysse av om sonen skal inngå i tilstedeværelsessimuleringen (Modul 1). Kun avkryssede ("bebodde") soner brukes som kandidater.

---

## 5. Moduser og Systemtilstander

```
               [ Siste person forlater huset ]
                             │
                             ▼
               [ Utpasseringsforsinkelse: 60s ] ──(Sjekker batteri/offline)
                             │
                             ▼
                      [ Status: BORTE ]
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
   [ Dag / Før Solnedgang ]          [ Kveld / Etter Solnedgang ]
            │                                 │
            ▼                                 ▼
    (Kun overvåking)                  (Kevin-modus AKTIV)
            │                                 │
            └────────────────┬────────────────┘
                             │
                             ▼
                [ Bevegelse registrert! ]
                             │
                             ▼
               [ Innpasseringsforsinkelse: 30s ]
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
   [ Bruker deaktiverer ]            [ Tiden løper ut ]
            │                                 │
            ▼                                 ▼
    (System avbrutt)                (REAKTIV AVSKREKKING)

```

### 5.1. Deaktivert (Disarmed)

Systemet er inaktivt. Ingen simulering eller avskrekkingslogikk kjører.

### 5.2. Aktivert: Borte (Armed Away)

Aktiveres manuelt fra Dashboard eller via Flow-kort (ingen automatisk arming basert på tilstedeværelse).

* **Ved aktivering (Helsesjekk):** Appen scanner alle tilknyttede sensorer. Hvis en sensor er offline, sendes et pushvarsel: *"McCallister Guard aktivert, men [Sensor Navn] rapporterer ikke."* (Batterinivå sjekkes ikke.)
* **Utpasseringsforsinkelse (Exit Delay):** Nedtelling starter (f.eks. 60s). Alle lys slås av, og sensorer ignoreres under nedtellingen.

### 5.3. Aktivert: Natt / Skallsikring (Armed Stay)

Brukes når huseier sover.

* Tilstedeværelsessimulering (Modul 1) er **DEAKTIVERT**.
* **Brukervalgte perimeter-sensorer er aktive** — konfigureres per sone i settings-UI under
  «Soneoversikt» i feltet **Skallsikring** (innstillingen `perimeter_sensors`). Typisk valg er
  ytterdører, vinduer og utendørssensorer. Bevegelsessensorer innendørs hakes vanligvis vekk slik
  at man kan gå rundt om natten uten å utløse alarm.
* Alle andre sensorer som ikke er hakket av som perimeter-sensorer **ignoreres** i denne modusen.
* Hvis ingen sensorer er valgt globalt, brukes alle sensorer som fallback (bakoverkompatibelt).
* Når en perimeter-sensor trigges hoppes det over "mind-games" og det går rett til *Eskalert Alarm (Krise)*.

---

## 6. Funksjonelle Moduler (Logikk)

### Modul 1: Kevin-Modus (Tilstedeværelsessimulering)

* **Betingelse:** `Status = Borte` **OG** `Tid er mellom (Solnedgang + Sunset Offset) og Bedtime`.
* **Handling:** Appen velger ut 1–3 tilfeldige soner fra brukerens whitelist (`Kevin-modus Soner`, se §4.2). Slår på lys (og eventuelt svak TV-lyd) i disse rommene. Velger et tilfeldig tidsstempel innenfor `Random Min/Max`. Når tiden utløper, slås disse av, og prosessen gjentas i nye tilfeldige rom. Dette simulerer naturlig bevegelse i huset.

### Modul 2: Reaktive Avskrekkings- "Mind-games"

* **Betingelse:** `Status = Borte` **OG** en sensor utløses etter at Innpasseringsforsinkelsen (Entry Delay) har utløpt uten deaktivering.
* **Logikk (Trinn 1):**
1. Bevegelse oppdages i **Sone A** (f.eks. Gang).
2. Appen slår opp i matrisen og finner **Sone B** (f.eks. Hovedsoverom).
3. I **Sone B** slås lyset på full styrke. Hvis det finnes en skjerm der, castes en video som blinker rødt og blått (blålys-simulering). Høyttaleren i Sone B spiller av politisirene eller samtalelyd.
4. Pushvarsel sendes til eier: *"⚠️ INNBRUDD DETEKTERT! Tyv i [Sone A]. Avskrekking startet i [Sone B]."*


* **Logikk (Trinn 2 - Tyven flytter seg):**
1. Hvis tyven beveger seg mot Sone B, og en sensor nærmere eller i Sone B trigges:
2. **Mørklegging:** Sone B slås **AV** umiddelbart (Lyd, lys og skjerm slukkes på < 1 sekund). Tyven skal tro de ble oppdaget eller at politiet forflyttet seg.
3. **Pause:** Systemet venter i `Deterrence Delay` (f.eks. 15 sekunder) i totalt mørke og stillhet.
4. **Ny start:** Appen slår opp i matrisen for den nye sonen tyven befinner seg i, og starter avskrekkingen i en helt ny sone (**Sone C**).



### Modul 3: Falsk alarm-filter & Alarm-eskalering

* **Falsk alarm-filter (Bekreftet alarm):** For å unngå at et husdyr eller en robotstøvsuger starter full eskalering, kreves det at enten en dørkontakt brytes + bevegelse, ELLER at to ulike soner registrerer bevegelse innenfor 90 sekunder, før alarmen defineres som "Bekreftet". 90-sekunders-vinduet er glidende, men **nullstilles ved deaktivering** (bevegelser før deaktivering teller ikke videre). En enkeltstående trigger vil kun starte Modul 2 (mildere avskrekking), ikke Modul 3.
* **Eskaleringslogikk:** Hvis det registreres kontinuerlig bevegelse i huset i mer enn `Escalation Time` (default 5 minutter, konfigurerbar i GUI) etter første deteksjon (avskrekkingen fungerte ikke):
1. Appen går i **Krise-tilstand**.
2. Samtlige smarthøyttalere i hele huset settes til **100% volum** og spiller en øredøvende ekte alarmsirene.
3. Alle lys i hele huset begynner å blinke hvitt og rødt (strobelys-effekt) for å tiltrekke seg naboers oppmerksomhet.
4. Kritisk Push-varsel sendes til eier: *"🚨 KRITISK: Avskrekkingsmetode feilet. Innbrudd pågår fortsatt etter [Escalation Time] minutter!"*



### Modul 4: Kameraovervåking & Snapshot-loop

* **Betingelse:** Avskrekkingsmodus (Modul 2) eller Krise-tilstand (Modul 3) er aktiv.
* **Handling:** I alle rom der det er registrert bevegelse, og det finnes et tilknyttet kamera:
1. Start en intern loop som tar et snapshot **hvert 5. sekund**.
2. Bildet sendes umiddelbart som push-varsel med bildevedlegg til eierens smarttelefon, slik at eier kan identifisere tyven og videresende til politiet i sanntid.
3. **Maks 3 push-varsler per hendelse** for å unngå spam. Resterende snapshots lagres lokalt og kan ses i Dashboard / hendelseslogg.



### Modul 5: Strikte Lysrestriksjoner (Uautorisert lys-av)

* **Betingelse:** `Status = Borte`.
* **Handling:** Hvis et lys i huset endrer tilstand til `PÅ`, gjør appen en sjekk: *Ble dette lyset slått på av McCallister Guard-appen (Modul 1 eller Modul 2)?*
* **Implementasjon:** Appen holder en intern buffer over egne `onoff=true`-kommandoer i siste ~2 sekunder. Endringer i lysstatus som *ikke* matcher en buffret kommando regnes som uautoriserte.
* **Konsekvens:** Hvis lyset ble slått på manuelt (f.eks. av en tyv som trykker på en fysisk veggbryter, eller etter strømbrudd-resett), sender appen en `AV`-kommando umiddelbart (< 1 sekund). *Et mørkt hus tvinger tyven til å bruke lommelykt, som gjør det lettere for bevegelsessensorer og kameraer å fange dem opp.*

---

## 6.1. Mediaressurser (Pakket med appen)

* **Blålys-animasjon:** En lokal MP4-/animasjonsfil pakkes i `assets/media/blue-lights.mp4` og castes til skjermer som støtter `cast`/Chromecast i reaksjonssonen.
* **Fallback (uten skjerm):** Hvis ingen castbar skjerm finnes i reaksjonssonen, simuleres blålys ved å blinke smartpærer mellom blå og hvit ved hjelp av `light_hue`/`light_saturation`/`dim`.
* **Politisirene:** En royalty-free `.mp3` (politisirene) pakkes i `assets/media/police-siren.mp3` og brukes som fallback dersom `Custom Audio URL` ikke er satt.

## 6.2. Cast-enhet pr. sone — prioritering og overstyring

Når en sone har flere cast-bare enheter (f.eks. TV + Nest Hub + Sonos), velger appen automatisk den
mest egnede via `lib/CastPriority.ts`. Rangeringen (`castRank`) gir poeng for hver egenskap, høyere
score vinner:

| Egenskap | Poeng |
|---|---|
| Video (`isCastableScreen`) | +50 |
| TV-aktig (`class === 'tv'` eller driver matcher `chromecast/androidtv/appletv/webos/bravia/samsung.tv/nest.hub`) | +30 |
| Direkte `cast_url`-capability | +15 |
| Kun lyd (ikke video) | +10 |

Eksempler: en TV med `cast_url` → 95, en TV uten cast_url → 80, en Nest Hub → 95 (TV-aktig regex),
en Sonos Beam → 60 (video uten TV-treff), en Nest Audio → 10 (kun lyd).

Settings-feltet **`cast_devices: Record<zoneId, string[]>`** lagrer brukerens overstyring per sone:

* **Sone ikke i map** → auto-pick brukes (også for nye enheter som dukker opp senere).
* **Sone har array** → kun de id-ene som er listet brukes; tom array deaktiverer cast i sonen.

UI-en under «Soneoversikt» viser per cast-enhet: ikon (📺 TV, 🖥️ video, 🔊 lyd), navn,
type-tags og en «auto»-pille på den enheten som ville blitt valgt automatisk. Checkbox-listen
er forhåndskrysset basert på `cast_devices[zoneId] ?? castAutoPick`.

`MediaCaster.startBlueLights` og `MediaCaster.startSiren` respekterer utvalget via
`selectedCastIds(zoneId, devices)`. Audio-sirene har en ekstra fallback til hvilken som helst
høyttaler i sonen hvis den valgte enheten ikke responderer, for å unngå at en uventet feil
slukker krise-sirenen.

---

## 7. Integrasjon med Homey Presence (Flow-kort SDK)

Appen skal eksponere ferdige Flow-kort for å gjøre oppsettet sømløst mot Homeys tilstedeværelsesfunksjoner.

### Triggere (NÅR...)

* `McCallister Guard: Avskrekking startet i sone [Sone]`
* `McCallister Guard: Alarm eskalert til KRISENIVÅ`
* `McCallister Guard: Uautorisert lys slått av automatisk`
* `McCallister Guard: Helsesjekk feilet (Lavt batteri/Offline enheter)`

### Betingelser (OG...)

* `Systemet er aktivert i [Borte-modus / Natt-modus]`
* `En sone-avskrekking pågår akkurat nå`

### Handlinger (DA...)

* `Aktiver McCallister Guard (Borte-modus med tidsforsinkelse)`
* `Aktiver McCallister Guard (Natt-modus umiddelbart)`
* `Deaktiver McCallister Guard (Start innpasseringsforsinkelse)`
* `Utløs Panikk-knapp (Full eskalering umiddelbart)`