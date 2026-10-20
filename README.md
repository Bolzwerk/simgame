# PixelPolis

Ein Städtebauspiel im Stil von SimCity 2000 für Android-Handys: isometrische Pixelgrafik, Gelände mit Hügeln und Wasser, Wohn-, Gewerbe- und Industriezonen, Strom, Verkehr, Budget und Katastrophen. Alle Grafiken werden beim Start prozedural im Spiel erzeugt, es werden keine Originaldateien verwendet.

## Aufs Handy bringen

1. Auf dem Handy die neueste Version öffnen: **https://github.com/Bolzwerk/simgame/releases/latest/download/PixelPolis.apk**
2. Die heruntergeladene Datei antippen. Beim ersten Mal fragt Android, ob der Browser (oder „Eigene Dateien“) Apps installieren darf: erlauben.
3. „Installieren“ antippen und PixelPolis starten.

Neue Versionen werden bei jedem Merge auf `main` automatisch gebaut (GitHub Actions) und unter *Releases* veröffentlicht. Sie lassen sich einfach über die alte Version installieren, die Spielstände bleiben erhalten.

Das Spiel passt sich an jedes Seitenverhältnis an. Auf dem Galaxy Z Fold läuft es zugeklappt im Hochformat (Werkzeugleiste unten) und aufgeklappt (Werkzeugleiste links); beim Auf- und Zuklappen läuft das Spiel ohne Neustart weiter.

## Spielen

- **Schwierigkeit:** Leicht (20.000 $), Mittel (10.000 $), Schwer (5.000 $, teurer Unterhalt, häufigere Katastrophen) und **Sandkasten** (unbegrenztes Geld, alles freigeschaltet, Katastrophen nur auf Knopfdruck).
- **Bedienung:** Mit einem Finger bauen (Straßen, Leitungen und Zonen durch Ziehen), mit zwei Fingern verschieben und zoomen. Das Info-Werkzeug zeigt Details zu einem Feld; mit ihm verschiebt ein Finger die Karte.
- **Wachstum:** Kraftwerk bauen und per Leitung anschließen, Zonen ausweisen, Straßen in höchstens drei Feldern Entfernung. Die Nachfrage-Anzeige oben zeigt, was gebraucht wird. Polizei, Feuerwehr, Schulen, Krankenhäuser und Parks heben den Bodenwert, damit Hochhäuser entstehen.
- **Wasser:** Ab der dritten Bebauungsstufe brauchen Gebäude Wasser. Wasserpumpen (am Ufer ergiebiger) oder Wassertürme bauen, mit Strom versorgen und über unterirdische Rohre an die Zonen anschließen. Beim Rohrwerkzeug schaltet die Karte automatisch in die Untergrundansicht. Alte Spielstände haben zehn Spieljahre Schonfrist.
- **Ansichten:** Strom, Wasser, Bodenwert, Verschmutzung, Kriminalität, Verkehr und Abdeckung der Dienste.
- Spielstände: drei Speicherplätze plus automatisches Speichern.

## Entwicklung

Das Spiel ist in TypeScript geschrieben und wird mit esbuild zu einer einzelnen Datei gebündelt, die eine kleine Android-App in einer WebView anzeigt.

```
npm ci
npm run build      # bündelt nach dist/ und android/app/src/main/assets/www/
npm run serve      # zum Testen im Browser: http://localhost:8080/
npm run typecheck
```

APK bauen (mit Android-SDK, JDK 17):

```
npm run build
cd android && ./gradlew assembleRelease
```

Ohne SDK geht es auch mit den Ubuntu-Paketen `aapt dalvik-exchange apksigner zipalign` und einer `android.jar`: `ANDROID_JAR=… scripts/build-apk-local.sh`.

| Ordner | Inhalt |
| --- | --- |
| `src/sim.ts` | Simulation: Strom, Wasser, Wachstum, Verkehr, Umwelt, Finanzen, Katastrophen |
| `src/sprites.ts`, `src/pix.ts` | Pixelgrafik-Erzeugung (Gelände, Straßen, Gebäude) |
| `src/render.ts` | Isometrische Darstellung mit Chunk-Zwischenspeicher und Tiefenpuffer |
| `src/anim.ts` | Animationen: Autos, Fußgänger, Boote, Rauch, Windräder, Flugzeuge, Vögel |
| `src/game.ts`, `src/ui.ts` | Bedienoberfläche, Werkzeugleiste, Dialoge |
| `src/tools.ts`, `src/terrain.ts` | Bauwerkzeuge, Kartenerzeugung, Geländebearbeitung |
| `android/` | Android-Hülle (WebView, Speichern, Zurück-Taste) |

Der Signaturschlüssel `android/app/pixelpolis.keystore` liegt bewusst im Repository, damit jede gebaute Version die vorherige ohne Deinstallation aktualisieren kann. Für eine Veröffentlichung im Play Store bräuchte es einen eigenen, geheimen Schlüssel.
