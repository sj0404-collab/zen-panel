package eu.kanade.tachiyomi.data.ai

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * Экспорт сообщений чата в документы БЕЗ внешних библиотек:
 *
 * • PDF — системный android.graphics.pdf.PdfDocument: текст с переносами
 *   (StaticLayout) и картинки, многостраничный A4.
 * • DOCX — это zip с OOXML-файлами; собирается вручную (ZipOutputStream):
 *   [Content_Types].xml + document.xml + relationships + media/…jpg.
 *   Открывается Word/WPS/Google Docs — проверенная минимальная структура.
 *
 * Правило (по требованию пользователя): текст без картинок -> и PDF и DOCX
 * доступны; если среди выделенных сообщений есть картинка — экспорт идёт
 * в DOCX или PDF (не в plain text).
 */
object DocExporter {

    data class Item(val title: String, val text: String, val imagePath: String?)

    // ---------- PDF ----------

    fun exportPdf(context: Context, items: List<Item>, fileName: String): File {
        val doc = PdfDocument()
        val pageW = 595 // A4 @72dpi
        val pageH = 842
        val margin = 40f
        val contentW = (pageW - margin * 2).toInt()

        val titlePaint = TextPaint().apply {
            color = Color.BLACK; textSize = 13f; isFakeBoldText = true; isAntiAlias = true
        }
        val textPaint = TextPaint().apply {
            color = Color.DKGRAY; textSize = 11f; isAntiAlias = true
        }

        var page = doc.startPage(PdfDocument.PageInfo.Builder(pageW, pageH, doc.pages.size + 1).create())
        var canvas = page.canvas
        var y = margin

        fun newPage() {
            doc.finishPage(page)
            page = doc.startPage(PdfDocument.PageInfo.Builder(pageW, pageH, doc.pages.size + 1).create())
            canvas = page.canvas
            y = margin
        }

        fun drawText(paint: TextPaint, text: String) {
            if (text.isBlank()) return
            val layout = StaticLayout.Builder.obtain(text, 0, text.length, paint, contentW)
                .setAlignment(Layout.Alignment.ALIGN_NORMAL).setLineSpacing(2f, 1f).build()
            var line = 0
            while (line < layout.lineCount) {
                val lineBottom = layout.getLineBottom(line) - layout.getLineTop(line)
                if (y + lineBottom > pageH - margin) newPage()
                // Рисуем построчно, чтобы уметь переносить через страницы
                val start = layout.getLineStart(line)
                val end = layout.getLineEnd(line)
                canvas.drawText(text.substring(start, end).trimEnd(), margin, y + paint.textSize, paint)
                y += lineBottom
                line++
            }
            y += 6f
        }

        for (item in items) {
            drawText(titlePaint, item.title)
            drawText(textPaint, item.text)
            val img = item.imagePath?.let { BitmapFactory.decodeFile(it) }
            if (img != null) {
                val scale = minOf(contentW.toFloat() / img.width, 1f)
                val w = (img.width * scale).toInt()
                val h = (img.height * scale).toInt()
                if (y + h > pageH - margin) newPage()
                val scaled = if (scale < 1f) Bitmap.createScaledBitmap(img, w, h, true) else img
                canvas.drawBitmap(scaled, margin, y, Paint(Paint.FILTER_BITMAP_FLAG))
                y += h + 10f
                if (scaled !== img) scaled.recycle()
                img.recycle()
            }
            y += 8f
        }
        doc.finishPage(page)

        val out = File(File(AiWorkspace.root(context), "export"), fileName).apply { parentFile?.mkdirs() }
        out.outputStream().use { doc.writeTo(it) }
        doc.close()
        return out
    }

    // ---------- DOCX (минимальный валидный OOXML) ----------

    fun exportDocx(context: Context, items: List<Item>, fileName: String): File {
        val out = File(File(AiWorkspace.root(context), "export"), fileName).apply { parentFile?.mkdirs() }
        val images = items.mapIndexedNotNull { i, item ->
            item.imagePath?.let { path -> Triple(i, "image${i + 1}.jpg", path) }
        }

        ZipOutputStream(out.outputStream()).use { zip ->
            fun put(name: String, content: ByteArray) {
                zip.putNextEntry(ZipEntry(name))
                zip.write(content)
                zip.closeEntry()
            }
            fun put(name: String, content: String) = put(name, content.toByteArray(Charsets.UTF_8))

            val imageTypes = if (images.isEmpty()) "" else
                """<Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="jpeg" ContentType="image/jpeg"/>"""
            put(
                "[Content_Types].xml",
                """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>$imageTypes
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>""",
            )
            put(
                "_rels/.rels",
                """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>""",
            )
            val imageRels = images.joinToString("") { (i, name, _) ->
                """<Relationship Id="rImg$i" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/$name"/>"""
            }
            put(
                "word/_rels/document.xml.rels",
                """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">$imageRels</Relationships>""",
            )

            val body = StringBuilder()
            for ((idx, item) in items.withIndex()) {
                body.append("<w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space=\"preserve\">")
                    .append(xmlEscape(item.title)).append("</w:t></w:r></w:p>")
                item.text.lines().forEach { line ->
                    body.append("<w:p><w:r><w:t xml:space=\"preserve\">")
                        .append(xmlEscape(line)).append("</w:t></w:r></w:p>")
                }
                val img = images.firstOrNull { it.first == idx }
                if (img != null) {
                    val bmp = BitmapFactory.decodeFile(img.third)
                    if (bmp != null) {
                        // EMU: 9525 на пиксель; ограничиваем ширину 15 см
                        val maxW = 5_400_000L
                        var wEmu = bmp.width * 9525L
                        var hEmu = bmp.height * 9525L
                        if (wEmu > maxW) {
                            hEmu = hEmu * maxW / wEmu
                            wEmu = maxW
                        }
                        bmp.recycle()
                        body.append(
                            """<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="$wEmu" cy="$hEmu"/><wp:docPr id="${img.first + 1}" name="${img.second}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${img.first + 1}" name="${img.second}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rImg${img.first}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="$wEmu" cy="$hEmu"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>""",
                        )
                    }
                }
            }
            put(
                "word/document.xml",
                """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>$body<w:sectPr/></w:body></w:document>""",
            )
            for ((_, name, path) in images) {
                // Перекодируем в JPEG (вдруг это png/webp)
                val bmp = BitmapFactory.decodeFile(path) ?: continue
                zip.putNextEntry(ZipEntry("word/media/$name"))
                bmp.compress(Bitmap.CompressFormat.JPEG, 88, zip)
                zip.closeEntry()
                bmp.recycle()
            }
        }
        return out
    }

    private fun xmlEscape(s: String) = s
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\"", "&quot;").replace("'", "&apos;")
}
