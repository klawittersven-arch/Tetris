# KBS Tetris-Klassenturnier

Die ganze Klasse spielt Tetris mit den eigenen Smartphones, der Laptop der Lehrkraft zeigt alles am Beamer. Es muss nichts installiert werden: Alle scannen einen QR-Code.

- **Runde 1 – Qualifikation:** Bis zu 30 SuS spielen gleichzeitig Tetris **auf ihrem Handy** (Spielfeld + 3 Knöpfe: ◀ ↻ ▶; Tippen aufs Spielfeld lässt den Stein sofort fallen). Am Beamer läuft eine Live-Rangliste. Die **ersten zwei**, die die Zielpunktzahl erreichen, kommen ins Finale. Wer vollläuft, bekommt ein neues Feld und beginnt wieder bei 0 Punkten.
- **Runde 2 – Finale:** Die beiden Finalisten spielen am Beamer gegeneinander, gesteuert mit ihren Handys (wieder ◀ ↻ ▶, Tippen in die Bildschirmmitte = Stein fallen lassen). Wer 2 oder mehr Reihen auf einmal löscht, schickt Müllzeilen zum Gegner (2 → 1, 3 → 2, Tetris → 4). Wer oben anstößt, verliert. Alle anderen sehen auf dem Handy „Schau auf den Beamer“.
- Alle bekommen dieselbe Steinfolge – es zählt nur das Können.

Punkte (Standard-Tetris): 1 Reihe = 100, 2 Reihen = 300, 3 Reihen = 500, 4 Reihen = 800 – jeweils mal Level. Das Level steigt alle 10 Reihen bzw. alle 45 Sekunden (die Steine fallen dann schneller).

## Adresse & Einrichtung (Cloudflare)

**Link für den Laptop am Beamer: https://tetris.klawittersven.workers.dev**

Das Spiel und der Verbindungsdienst laufen auf Cloudflare (Workers + Durable Objects, kostenloser Tarif). Das Cloudflare-Projekt „tetris“ ist mit diesem GitHub-Repository verknüpft: Jede Änderung, die hochgeladen wird, geht nach ca. einer Minute automatisch online. Ob ein Update durchgelaufen ist, sieht man im Cloudflare-Dashboard unter **Workers & Pages → tetris → Deployments**.

Alte Links auf `klawittersven-arch.github.io/Tetris` leiten automatisch auf die Cloudflare-Adresse um.

## Ablauf im Unterricht

1. Laptop an den Beamer, die Seite öffnen, mit **F11** Vollbild.
2. **Lobby:** Alle scannen den QR-Code, geben ihren Namen ein und tippen **Mitspielen**. Die Namen erscheinen am Beamer (gleiche Namen werden durchnummeriert). Antippen eines Namens entfernt die Person.
3. **Zielpunktzahl** einstellen (Standard 100 = eine gelöschte Reihe; für längere Runden z. B. 500 oder 1000).
4. **Runde 1 starten** (Enter), sobald genug SuS dabei sind (mind. 2). Nach dem Countdown spielen alle auf dem Handy. Nachzügler können über den kleinen QR-Code oben rechts noch einsteigen.
5. Haben zwei SuS das Ziel erreicht, zeigt der Beamer **„FINALE: A vs. B“**. **Finale starten** (Enter).
6. Nach dem Finale: **Revanche** (Enter, gleiche Finalisten, Rundenstand zählt weiter) oder **Neues Spiel** (Esc → zurück zur Lobby, alle bleiben verbunden).

### Tasten für die Lehrkraft

| Taste | Funktion |
|---|---|
| Enter | Runde 1 starten / Finale starten / Revanche |
| P | Pause / weiter (in beiden Runden) |
| Esc | zurück zur Lobby / neues Spiel |
| F11 | Vollbild |

Verliert ein Finalisten-Handy die Verbindung, pausiert das Finale automatisch und geht weiter, sobald das Handy wieder verbunden ist (Seite neu laden oder QR-Code erneut scannen).

### Testen ohne Handys (nur Finale)

Spieler 1: A / D bewegen, W drehen, S fallen lassen · Spieler 2: ← / → bewegen, ↑ drehen, ↓ fallen lassen

## Technik & Fehlerbehebung

- Beamer und Handys sprechen nicht direkt miteinander. Alle Nachrichten laufen über den eigenen Cloudflare-Dienst unter derselben Adresse wie das Spiel – über normales HTTPS (Port 443), das Schulfilter praktisch immer durchlassen. Pro Raum verwaltet ein „Durable Object“ die Verbindungen.
- Die Handys nutzen eine Dauerverbindung (WebSocket). Klappt die nicht, fragen sie automatisch alle 1,5 Sekunden per normaler HTTPS-Anfrage nach (im Finale alle 0,25 s) – das funktioniert auch hinter strengen Filtern.
- In Runde 1 schickt jedes Handy seinen Punktestand höchstens alle 1,5 Sekunden; wer das Ziel erreicht, meldet das sofort.
- Übertragen werden nur Vornamen, Punktestände und Tastendrücke, unter einem zufälligen Raumcode. Nichts wird dauerhaft gespeichert.
- **„Raum nicht gefunden“**: Ist die Beamer-Seite offen und zeigt „Bereit – Handys können beitreten“? Code richtig?
- **„Der Server ist gerade nicht erreichbar“**: Das Handy hat kein Internet. WLAN prüfen oder mobile Daten probieren.
- **Neuer Raum**: Der Raumcode bleibt beim Neuladen der Beamer-Seite gleich – die Handys melden sich dann automatisch wieder an. Mit dem Button „Neuer Raum“ in der Lobby gibt es einen neuen Code; alle Handys müssen dann neu scannen.
- Die Beamer-Seite nur in **einem** Fenster öffnen; ein zweites Fenster mit demselben Raum übernimmt ihn.

### Dateien

```
index.html          Beamer: Lobby, Rangliste (Runde 1), Finale (Runde 2)
controller.html     Handy: eigenes Spiel (Runde 1) bzw. Steuerung (Finale)
js/tetris.js        Spiellogik (SRS-Drehung, 7-Bag, Müllzeilen)
js/render.js        Zeichnen von Spielfeld und Steinen (Beamer + Handy)
js/net.js           Verbindung zum Cloudflare-Dienst (WebSocket bzw. HTTP-Abfragen)
worker/index.js     Cloudflare Worker + Durable Object (Nachrichten-Vermittlung pro Raum)
wrangler.jsonc      Cloudflare-Konfiguration
.assetsignore       Dateien, die nicht öffentlich ausgeliefert werden
js/host.js          Verbindungen, Ablauf beider Runden, Darstellung am Beamer
js/controller.js    Handy: Verbindung, lokales Spiel, Knöpfe
css/                Gestaltung
img/kbs-logo.png    Schullogo
vendor/             qrcodejs 1.0.0 (MIT-Lizenz)
```
