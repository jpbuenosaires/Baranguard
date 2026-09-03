<?php
declare(strict_types=1);

namespace Baranguard\Services\Pdf;

/**
 * SimplePdf — a minimal, dependency-free PDF writer for the Lupon case
 * packet (§6 `POST /incidents/:id/lupon-packet`).
 *
 * WHY THIS EXISTS RATHER THAN A LIBRARY: this repo has no Composer and no
 * vendored PDF library, and §2 Rule 7 makes the deployment local-only —
 * pulling a dependency at deploy time is not a thing this project does.
 * The alternatives were vendoring FPDF (~2000 lines of third-party code
 * for one endpoint) or serving print-styled HTML (which is not the PDF
 * §6 asks for). A text-only PDF is a genuinely small format, so this
 * writes one directly.
 *
 * SCOPE, HONESTLY: this produces a plain text document — the base-14
 * Helvetica fonts every PDF reader is required to have, one column, no
 * images, no tables, no embedded fonts. That is exactly what a Lupon
 * packet needs (a case record for the Punong Barangay/Lupon to read and
 * file) and nothing more. It is NOT a general-purpose PDF library and
 * should not grow into one.
 *
 * TEXT ENCODING: base-14 Helvetica with `/WinAnsiEncoding` covers
 * Latin-1, which handles Filipino text including ñ/é. Anything outside
 * that (a stray emoji, CJK) is replaced with '?' rather than emitting
 * bytes that would render as garbage — see `toWinAnsi()`.
 *
 * LINE WRAPPING IS APPROXIMATE. Exact wrapping needs the font's per-glyph
 * advance widths, which would mean embedding Helvetica's metrics table.
 * Instead this estimates using an average advance of 0.5 em, which for
 * Helvetica runs slightly wide (safe: lines break early rather than
 * overrunning the right margin). A line of unusually wide characters
 * (WWWW) may wrap sooner than strictly necessary; nothing overflows.
 */
final class SimplePdf
{
    // A4 in PostScript points (72pt = 1 inch).
    private const PAGE_WIDTH = 595.28;
    private const PAGE_HEIGHT = 841.89;
    private const MARGIN = 56.7; // 20mm

    private const FONT_REGULAR = 'F1';
    private const FONT_BOLD = 'F2';

    /** Conservative average glyph advance as a fraction of font size. */
    private const AVG_ADVANCE_RATIO = 0.5;

    /** @var array<int, array{text:string,size:float,font:string,leading:float}> */
    private array $lines = [];

    private function __construct(private readonly string $title)
    {
    }

    public static function create(string $title): self
    {
        return new self($title);
    }

    public function heading(string $text, float $size = 15.0): self
    {
        $this->spacer(6);
        foreach ($this->wrap($text, $size) as $line) {
            $this->lines[] = ['text' => $line, 'size' => $size, 'font' => self::FONT_BOLD, 'leading' => $size * 1.45];
        }
        $this->spacer(4);
        return $this;
    }

    public function paragraph(string $text, float $size = 10.5): self
    {
        // Preserve the author's own paragraph breaks, wrap within each.
        foreach (preg_split('/\R/u', $text) ?: [$text] as $sourceLine) {
            if (trim($sourceLine) === '') {
                $this->spacer(6);
                continue;
            }
            foreach ($this->wrap($sourceLine, $size) as $line) {
                $this->lines[] = ['text' => $line, 'size' => $size, 'font' => self::FONT_REGULAR, 'leading' => $size * 1.5];
            }
        }
        $this->spacer(5);
        return $this;
    }

    /** A "Label: value" metadata row, label in bold. */
    public function keyValue(string $label, string $value, float $size = 10.5): self
    {
        foreach ($this->wrap($label . ': ' . $value, $size) as $index => $line) {
            $this->lines[] = [
                'text' => $line,
                'size' => $size,
                // Only the first line of a wrapped pair carries the label.
                'font' => $index === 0 ? self::FONT_BOLD : self::FONT_REGULAR,
                'leading' => $size * 1.45,
            ];
        }
        return $this;
    }

    public function spacer(float $points = 10.0): self
    {
        $this->lines[] = ['text' => '', 'size' => 0.0, 'font' => self::FONT_REGULAR, 'leading' => $points];
        return $this;
    }

    /** A full-width horizontal rule, drawn with underscores (no graphics operators needed). */
    public function rule(): self
    {
        $usable = self::PAGE_WIDTH - (2 * self::MARGIN);
        $count = (int) floor($usable / (9.0 * self::AVG_ADVANCE_RATIO));
        $this->lines[] = ['text' => str_repeat('_', max(1, $count)), 'size' => 9.0, 'font' => self::FONT_REGULAR, 'leading' => 14.0];
        return $this;
    }

    /**
     * Renders the finished document as PDF bytes.
     *
     * Builds every object first, recording each one's byte offset, because
     * the cross-reference table at the end must point at exact positions —
     * a wrong offset is the single most common way a hand-written PDF
     * fails to open.
     */
    public function render(): string
    {
        $pages = $this->paginate();
        $pageCount = max(1, count($pages));

        // Object numbering: 1 = catalog, 2 = page tree, 3..(2+n) = pages,
        // then one content stream per page, then the two fonts.
        $firstPageObj = 3;
        $firstContentObj = $firstPageObj + $pageCount;
        $fontRegularObj = $firstContentObj + $pageCount;
        $fontBoldObj = $fontRegularObj + 1;

        $objects = [];

        $kids = [];
        for ($i = 0; $i < $pageCount; $i++) {
            $kids[] = ($firstPageObj + $i) . ' 0 R';
        }

        $objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
        $objects[2] = '<< /Type /Pages /Kids [' . implode(' ', $kids) . '] /Count ' . $pageCount . ' >>';

        for ($i = 0; $i < $pageCount; $i++) {
            $objects[$firstPageObj + $i] =
                '<< /Type /Page /Parent 2 0 R '
                . '/MediaBox [0 0 ' . self::num(self::PAGE_WIDTH) . ' ' . self::num(self::PAGE_HEIGHT) . '] '
                . '/Contents ' . ($firstContentObj + $i) . ' 0 R '
                . '/Resources << /Font << /' . self::FONT_REGULAR . ' ' . $fontRegularObj . ' 0 R '
                . '/' . self::FONT_BOLD . ' ' . $fontBoldObj . ' 0 R >> >> >>';

            $stream = $this->contentStream($pages[$i]);
            $objects[$firstContentObj + $i] = '<< /Length ' . strlen($stream) . " >>\nstream\n" . $stream . "\nendstream";
        }

        $objects[$fontRegularObj] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
        $objects[$fontBoldObj] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

        ksort($objects);
        $maxObj = array_key_last($objects);

        $pdf = "%PDF-1.4\n";
        // A binary comment marks the file as containing 8-bit data, so
        // naive tools don't treat it as text and mangle line endings.
        $pdf .= "%\xE2\xE3\xCF\xD3\n";

        $offsets = [];
        foreach ($objects as $number => $body) {
            $offsets[$number] = strlen($pdf);
            $pdf .= $number . " 0 obj\n" . $body . "\nendobj\n";
        }

        $xrefOffset = strlen($pdf);
        $pdf .= 'xref' . "\n" . '0 ' . ($maxObj + 1) . "\n";
        // Object 0 is always the head of the free list, exactly this form.
        $pdf .= "0000000000 65535 f \n";
        for ($number = 1; $number <= $maxObj; $number++) {
            $offset = $offsets[$number] ?? 0;
            $pdf .= sprintf("%010d 00000 n \n", $offset);
        }

        $pdf .= 'trailer' . "\n" . '<< /Size ' . ($maxObj + 1) . ' /Root 1 0 R /Info << /Title ('
            . self::escape(self::toWinAnsi($this->title)) . ') /Producer (Baranguard) >> >>' . "\n";
        $pdf .= 'startxref' . "\n" . $xrefOffset . "\n" . '%%EOF';

        return $pdf;
    }

    /**
     * Splits the accumulated lines into pages that fit the text area.
     *
     * @return array<int, array<int, array{text:string,size:float,font:string,leading:float}>>
     */
    private function paginate(): array
    {
        $usableHeight = self::PAGE_HEIGHT - (2 * self::MARGIN);
        $pages = [];
        $current = [];
        $used = 0.0;

        foreach ($this->lines as $line) {
            if ($used + $line['leading'] > $usableHeight && $current !== []) {
                $pages[] = $current;
                $current = [];
                $used = 0.0;
                // A spacer that only exists to separate blocks is dropped
                // at a page break rather than indenting the new page's top.
                if ($line['text'] === '') {
                    continue;
                }
            }
            $current[] = $line;
            $used += $line['leading'];
        }
        if ($current !== []) {
            $pages[] = $current;
        }

        return $pages === [] ? [[]] : $pages;
    }

    /** @param array<int, array{text:string,size:float,font:string,leading:float}> $lines */
    private function contentStream(array $lines): string
    {
        $stream = "BT\n";
        // Start at the top-left of the text area. PDF's origin is
        // bottom-left, so the first baseline sits one line below the top.
        $stream .= self::num(self::MARGIN) . ' ' . self::num(self::PAGE_HEIGHT - self::MARGIN) . " Td\n";

        $currentFont = null;
        $currentSize = null;

        foreach ($lines as $line) {
            if ($line['text'] === '') {
                $stream .= '0 ' . self::num(-$line['leading']) . " Td\n";
                continue;
            }
            if ($line['font'] !== $currentFont || $line['size'] !== $currentSize) {
                $stream .= '/' . $line['font'] . ' ' . self::num($line['size']) . " Tf\n";
                $currentFont = $line['font'];
                $currentSize = $line['size'];
            }
            $stream .= '0 ' . self::num(-$line['leading']) . " Td\n";
            $stream .= '(' . self::escape(self::toWinAnsi($line['text'])) . ") Tj\n";
        }

        return $stream . 'ET';
    }

    /**
     * Greedy word wrap using an estimated advance width — see the class
     * doc on why this is approximate rather than metric-exact.
     *
     * @return string[]
     */
    private function wrap(string $text, float $size): array
    {
        $usable = self::PAGE_WIDTH - (2 * self::MARGIN);
        $maxChars = max(10, (int) floor($usable / ($size * self::AVG_ADVANCE_RATIO)));

        $words = preg_split('/\s+/u', trim($text)) ?: [];
        if ($words === []) {
            return [''];
        }

        $lines = [];
        $current = '';
        foreach ($words as $word) {
            // A single word longer than a line (a URL, a long token) is
            // hard-split rather than allowed to overrun the margin.
            while (mb_strlen($word) > $maxChars) {
                if ($current !== '') {
                    $lines[] = $current;
                    $current = '';
                }
                $lines[] = mb_substr($word, 0, $maxChars);
                $word = mb_substr($word, $maxChars);
            }
            $candidate = $current === '' ? $word : $current . ' ' . $word;
            if (mb_strlen($candidate) > $maxChars) {
                $lines[] = $current;
                $current = $word;
            } else {
                $current = $candidate;
            }
        }
        if ($current !== '') {
            $lines[] = $current;
        }

        return $lines;
    }

    /**
     * UTF-8 -> CP1252 (WinAnsi), which is what the font resources above
     * declare. Unmappable characters become '?' — a visible, honest
     * placeholder rather than mojibake.
     */
    private static function toWinAnsi(string $text): string
    {
        if (function_exists('iconv')) {
            $converted = @iconv('UTF-8', 'CP1252//TRANSLIT', $text);
            if ($converted !== false) {
                return $converted;
            }
        }
        if (function_exists('mb_convert_encoding')) {
            $previous = mb_substitute_character();
            mb_substitute_character(0x3F); // '?'
            $converted = mb_convert_encoding($text, 'CP1252', 'UTF-8');
            mb_substitute_character($previous);
            return $converted;
        }
        // Last resort: strip anything non-ASCII rather than emit invalid bytes.
        return preg_replace('/[^\x20-\x7E]/', '?', $text) ?? $text;
    }

    /** Escapes the three characters that are special inside a PDF literal string. */
    private static function escape(string $text): string
    {
        return str_replace(['\\', '(', ')', "\r"], ['\\\\', '\\(', '\\)', ''], $text);
    }

    /** Formats a number without locale decimal-separator surprises. */
    private static function num(float $value): string
    {
        return rtrim(rtrim(number_format($value, 2, '.', ''), '0'), '.') ?: '0';
    }
}
