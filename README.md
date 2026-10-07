# Tetris-Duell für den Unterricht

Zwei Schülerinnen/Schüler spielen Tetris gegeneinander. Das Spielfeld läuft auf dem Laptop der Lehrkraft (Beamer), gesteuert wird mit den eigenen Smartphones. Es muss nichts installiert werden: Die Handys scannen einen QR-Code und werden zum Gamepad.

- **Beamer (`index.html`)**: beide Spielfelder, Rundenstand, QR-Codes zum Beitreten
- **Handy (`controller.html`)**: große Touch-Tasten, Vibration, Anzeige von Sieg/Niederlage
- **Duell-Modus**: Wer 2 oder mehr Reihen auf einmal löscht, schickt Müllzeilen zum Gegner (2 → 1, 3 → 2, Tetris → 4, dazu Combo- und Back-to-Back-Bonus). Wer oben anstößt, verliert die Runde.
- Beide bekommen dieselbe Steinfolge – es zählt nur das Können.

## Einmalig einrichten (GitHub Pages)

Die Handys brauchen eine Internetadresse, unter der das Spiel erreichbar ist. Am einfachsten über GitHub Pages:

1. Im Repository auf **Settings → Pages** gehen.
2. Bei **Source** „Deploy from a branch“ wählen, den Branch (z. B. `main`) und den Ordner `/ (root)` auswählen, **Save**.
3. Nach ca. einer Minute ist das Spiel erreichbar unter
   `https://klawittersven-arch.github.io/Tetris/`

Hinweis: GitHub Pages ist für öffentliche Repositories kostenlos. Bei einem privaten Repository braucht man ein kostenpflichtiges GitHub-Konto – oder man lädt die Dateien auf einen anderen Webspace (es sind nur statische Dateien).

## Ablauf im Unterricht

1. Laptop an den Beamer, die Seite öffnen und mit **F11** auf Vollbild schalten.
2. Zwei SuS scannen jeweils „ihren“ QR-Code (Spieler 1 / Spieler 2), geben ihren Namen ein und tippen auf **Mitspielen**. Die Karte wird grün.
   Alternativ: `…/controller.html` im Handy-Browser öffnen und den 5-stelligen Code eingeben.
3. **Spiel starten** (oder Enter). Nach dem Countdown geht es los.
4. Nach jeder Runde: **Nächste Runde** (Enter). Der Rundenstand steht in der Mitte.
5. Für den nächsten Durchgang: **Lobby** (oder Esc) → die Plätze werden frei, neue SuS können beitreten. Mit **Entfernen** kann ein Platz in der Lobby freigegeben werden.

### Tasten für die Lehrkraft

| Taste | Funktion |
|---|---|
| Enter | Spiel starten / nächste Runde |
| P | Pause / weiter |
| Esc | zurück zur Lobby (Rundenstand wird zurückgesetzt) |
| F11 | Vollbild |

Verliert ein Handy die Verbindung (z. B. Bildschirm aus), pausiert das Spiel automatisch. Sobald das Handy wieder verbunden ist (Seite neu laden oder QR-Code erneut scannen), geht es nach einem Countdown weiter.

### Steuerung am Handy

◀ ▶ bewegen (gedrückt halten = weiterlaufen) · ▼ schneller fallen · ↻ drehen · ↺ andersherum drehen · ⇄ Stein halten (tauschen) · ⤓ sofort fallen lassen

### Testen ohne Handys

Ein Platz ohne Handy kann per Tastatur gespielt werden:

- **Spieler 1:** A / D bewegen, S schneller, W drehen, Q andersherum, E halten, Leertaste fallen lassen
- **Spieler 2:** ← / → bewegen, ↓ schneller, ↑ drehen, `.` andersherum, `-` halten, rechte Shift-Taste fallen lassen

## Technik & Fehlerbehebung

- Das Spiel ist reines HTML/JavaScript ohne Server. Die Handys verbinden sich per **WebRTC** direkt mit dem Laptop; der kostenlose öffentliche PeerJS-Server (`0.peerjs.com`) vermittelt nur den Verbindungsaufbau. Laptop und Handys brauchen dafür Internet.
- **Am zuverlässigsten**: Laptop und Handys im selben WLAN.
- **„Raum nicht gefunden“**: Ist die Beamer-Seite offen und zeigt „Bereit – Handys können beitreten“? Code richtig eingegeben?
- **Handys verbinden sich nicht, obwohl der Raum gefunden wird**: Manche Schulnetze blockieren WebRTC-Verbindungen zwischen Geräten. Dann hilft es oft, wenn die Handys mobile Daten statt des Schul-WLANs nutzen (oder der Laptop über einen Handy-Hotspot ins Netz geht).
- Die Seite nicht als lokale Datei (`file://…`) öffnen, sonst können die Handys den QR-Code nicht nutzen.
- Eigener PeerJS-Server (optional, für Fortgeschrittene): `index.html?server=mein-server.de:443` – die Adresse wird automatisch an die Handys weitergegeben.

### Dateien

```
index.html          Beamer-Ansicht
controller.html     Handy-Gamepad
js/tetris.js        Spiellogik (SRS-Drehung, 7-Bag, Hold, Ghost, Müllzeilen)
js/host.js          Verbindungen, Spielablauf, Darstellung am Beamer
js/controller.js    Handy-Steuerung
css/                Gestaltung
vendor/             PeerJS 1.5.4 und qrcodejs 1.0.0 (MIT-Lizenz)
```
