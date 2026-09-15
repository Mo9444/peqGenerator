# PEQ Generator

Ein statischer, framework-loser JS-One-Pager, der aus einer gemessenen Frequenzgang-Datei
automatisch parametrische EQ-Bänder (Peaking-Filter) berechnet, um den Frequenzgang in einem
wählbaren Bereich möglichst flach zu machen. Inspiriert von [autoeq.app](https://autoeq.app/).

## Lokal ausprobieren

Kein Build, kein npm, kein Server nötig – einfach `index.html` im Browser öffnen (Doppelklick
oder per Rechtsklick → "Öffnen mit" → Browser). Funktioniert identisch, wenn die Datei später
z. B. via GitHub Pages gehostet wird.

1. `index.html` öffnen.
2. **Optional**, wenn mehrere Messungen derselben Position vorliegen (z. B. wiederholte Sweeps
   oder mehrere Sitz-/Mikrofonpositionen): alle Dateien in Schritt 1 reinziehen. Daraus wird
   punktweise eine einzelne Kurve berechnet (Median oder Mittelwert, wählbar – Median ist
   robuster gegen eine einzelne verrauschte/untypische Messung). Die zusammengeführte Kurve kann
   direkt für die Berechnung übernommen oder als Textdatei heruntergeladen werden.
3. Eine Datei aus `beispielfrequenzen/` per Drag&Drop oder Datei-Auswahl laden (oder eine eigene
   Messung im Format `Frequenz(Hz)<Tab/Leerzeichen>dB` pro Zeile – Header-/Textzeilen davor
   werden ignoriert) – oder die zusammengeführte Kurve aus Schritt 1 übernehmen.
4. Min./Max.-Frequenz einschränken, falls nur ein Teilbereich bearbeitet werden soll (z. B.
   `2000`–`20000` Hz, um nur den Hochtöner zu entzerren).
5. Anzahl der Bänder wählen und auf **Berechnen** klicken.
6. Ergebnis prüfen (Chart + Tabelle), Bänder bei Bedarf per Hand in der Tabelle feinjustieren.
7. Unten die Filter im Equalizer-APO-Format kopieren.

## Wie es rechnet

- Doppelte/rundungsgleiche Frequenzpunkte in der Datei werden gemittelt (nicht: letzter Wert
  gewinnt) – wichtig bei rohen, ungeglätteten Messungen mit vielen eng benachbarten Punkten.
- Die Messdatei wird auf ein logarithmisches Frequenzraster (20 Hz–20 kHz) resampled und leicht
  geglättet (1/6 Oktave, wie REW/AutoEQ es vor dem EQ-Fit empfehlen) – sonst würde der Fit auf
  einzelne Messrauschen-Spitzen reagieren statt auf den echten Verlauf.
- Zielwert = Mittelwert des Pegels im gewählten Frequenzfenster ("flach" heißt: auf dieses
  Niveau ziehen, nicht auf 0 dB absolut).
- Greedy-Fit: iterativ wird die größte verbleibende Abweichung gesucht, ein Peaking-Filter
  (exakte RBJ-Biquad-Formel) mit passender Güte (Q) und Gain draufgesetzt und von der
  Restabweichung abgezogen – bis die gewünschte Bandanzahl erreicht ist.
- Anschließend eine kurze Hill-Climbing-Nachbesserung (leichte Zufalls-Perturbation aller
  Bandparameter, nur behalten wenn die Gesamtabweichung sinkt) als einfacher Ersatz für einen
  echten numerischen Optimierer – analog zum Prinzip von AutoEQ, nur ohne externe Bibliotheken.
- Feste Grenzen (siehe `app.js`): Q 0.3–9.9, Gain −15…+15 dB.

## Dateien

- `index.html` – UI (Kurven-Zusammenführung, Upload, Steuerung, Chart, Tabelle, Export)
- `app.js` – Parser, Fit-Algorithmus, Biquad-Mathematik, Chart-Rendering, Export
- `beispielfrequenzen/` – Beispiel-Messungen zum Testen (inkl. `testcurves/` mit weiteren, teils
  rohen/ungeglätteten Kfz-Messungen)

## Hosten auf GitHub Pages

Repo auf GitHub pushen, dann unter **Settings → Pages** als Quelle den `main`-Branch (Root)
wählen. Da alles clientseitig läuft, ist kein weiterer Schritt nötig.
