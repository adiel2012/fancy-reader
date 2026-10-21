# Voz Alta

Lector que lee en voz alta PDF (incluso escaneados, con OCR), Markdown y texto.
No usa internet: todas las librerías están en `vendor/` y las fuentes en `fonts/`.

## Cómo abrirla

Haz doble clic en `start.bat`. Abre la app en el navegador (`http://localhost:8765/`)
y deja la ventana negra abierta mientras la uses. Necesita Python o Node.js instalado.

Hace falta un servidor local porque los navegadores bloquean los workers y archivos
auxiliares (pdf.js y el OCR) cuando una página se abre directamente desde el disco.
Sin servidor, los `.md`, `.txt` y la lectura de PDF con texto pueden funcionar, pero el OCR no.

Alternativas manuales, desde esta carpeta:

    python -m http.server 8765
    node serve.js 8765

## Estructura

    index.html          página
    css/styles.css      estilos
    js/app.js           lógica (lectura, voz, navegación, OCR)
    fonts/              Bricolage Grotesque, Literata, IBM Plex Mono (woff2)
    vendor/pdfjs/       pdf.js 3.11.174
    vendor/tesseract/   tesseract.js 5.1.1 y tesseract.js-core 5.1.0
    vendor/tessdata/    idiomas del OCR: spa, eng, fra, por, deu, ita
    serve.js            servidor mínimo en Node (alternativa a Python)
    start.bat           lanzador para Windows
