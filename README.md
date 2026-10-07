# Tetris-Klassenturnier für den Unterricht

Die ganze Klasse spielt Tetris mit den eigenen Smartphones, der Laptop der Lehrkraft zeigt alles am Beamer. Es muss nichts installiert werden: Alle scannen einen QR-Code.

- **Runde 1 – Qualifikation:** Bis zu 30 SuS spielen gleichzeitig Tetris **auf ihrem Handy** (Spielfeld + 3 Knöpfe: ◀ ↻ ▶; Tippen aufs Spielfeld lässt den Stein sofort fallen). Am Beamer läuft eine Live-Rangliste. Die **ersten zwei**, die die Zielpunktzahl erreichen, kommen ins Finale. Wer vollläuft, bekommt ein neues Feld und beginnt wieder bei 0 Punkten.
- **Runde 2 – Finale:** Die beiden Finalisten spielen am Beamer gegeneinander, gesteuert mit ihren Handys (wieder ◀ ↻ ▶, Tippen in die Bildschirmmitte = Stein fallen lassen). Wer 2 oder mehr Reihen auf einmal löscht, schickt Müllzeilen zum Gegner (2 → 1, 3 → 2, Tetris → 4). Wer oben anstößt, verliert. Alle anderen sehen auf dem Handy „Schau auf den Beamer“.
- Alle bekommen dieselbe Steinfolge – es zählt nur das Können.

Punkte (Standard-Tetris): 1 Reihe = 100, 2 Reihen = 300, 3 Reihen = 500, 4 Reihen = 800 – jeweils mal Level. Das Level steigt alle 10 Reihen bzw. alle 45 Sekunden (die Steine fallen dann schneller).

## Einmalig einrichten (GitHub Pages)

Die Handys brauchen eine Internetadresse, unter der das Spiel erreichbar ist:

1. Im Repository auf **Settings → Pages** gehen.
2. Bei **Source** „Deploy from a branch“ wählen, den Branch und den Ordner `/ (root)` auswählen, **Save**.
3. Nach ca. einer Minute ist das Spiel erreichbar unter `https://klawittersven-arch.github.io/Tetris/`

GitHub Pages ist für öffentliche Repositories kostenlos (bei privaten braucht man ein kostenpflichtiges Konto oder einen anderen Webspace – es sind nur statische Dateien).

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

- Reines HTML/JavaScript ohne eigenen Server. Die Handys verbinden sich per **WebRTC** direkt mit dem Laptop; der kostenlose öffentliche PeerJS-Server (`0.peerjs.com`) vermittelt nur den Verbindungsaufbau. Laptop und Handys brauchen dafür Internet.
- **Am zuverlässigsten**: Laptop und Handys im selben WLAN.
- **„Raum nicht gefunden“**: Ist die Beamer-Seite offen und zeigt „Bereit – Handys können beitreten“?
- **Handys verbinden sich nicht, obwohl der Raum gefunden wird**: Manche Schulnetze blockieren WebRTC zwischen Geräten. Dann hilft oft, wenn die Handys mobile Daten nutzen (oder der Laptop über einen Handy-Hotspot ins Netz geht).
- Die Seite nicht als lokale Datei (`file://…`) öffnen, sonst funktioniert der QR-Code nicht.
- Eigener PeerJS-Server (optional): `index.html?server=mein-server.de:443` – wird automatisch an die Handys weitergegeben.

### Dateien

```
index.html          Beamer: Lobby, Rangliste (Runde 1), Finale (Runde 2)
controller.html     Handy: eigenes Spiel (Runde 1) bzw. Steuerung (Finale)
js/tetris.js        Spiellogik (SRS-Drehung, 7-Bag, Müllzeilen)
js/render.js        Zeichnen von Spielfeld und Steinen (Beamer + Handy)
js/host.js          Verbindungen, Ablauf beider Runden, Darstellung am Beamer
js/controller.js    Handy: Verbindung, lokales Spiel, Knöpfe
css/                Gestaltung
vendor/             PeerJS 1.5.4 und qrcodejs 1.0.0 (MIT-Lizenz)
```
