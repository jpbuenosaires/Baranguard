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
    private const MARGIN = 54.0; // 0.75 inch (54 pt)

    private const FONT_REGULAR = 'F1';
    private const FONT_BOLD = 'F2';

    /** Conservative average glyph advance as a fraction of font size. */
    private const AVG_ADVANCE_RATIO = 0.50;

    /** @var array<int, array<string, mixed>> */
    private array $elements = [];

    private function __construct(private readonly string $title)
    {
    }

    public static function create(string $title): self
    {
        return new self($title);
    }

    /** Bold section heading with comfortable breathing room. */
    public function heading(string $text, float $size = 14.0): self
    {
        $this->spacer(8);
        foreach ($this->wrap($text, $size) as $line) {
            $this->elements[] = [
                'type' => 'text',
                'text' => $line,
                'size' => $size,
                'font' => self::FONT_BOLD,
                'leading' => $size * 1.40,
                'color' => [0.10, 0.15, 0.25],
            ];
        }
        $this->spacer(4);
        return $this;
    }

    /** Bold sub-heading with subtle accent. */
    public function subheading(string $text, float $size = 11.0): self
    {
        $this->spacer(5);
        $this->elements[] = [
            'type' => 'text',
            'text' => $text,
            'size' => $size,
            'font' => self::FONT_BOLD,
            'leading' => $size * 1.45,
            'color' => [0.12, 0.23, 0.43],
        ];
        $this->spacer(3);
        return $this;
    }

    /** Centered text line (e.g. for official letterheads). */
    public function center(string $text, float $size = 10.0, bool $bold = false, ?array $color = null, float $leading = 14.0): self
    {
        $this->elements[] = [
            'type' => 'center',
            'text' => $text,
            'size' => $size,
            'font' => $bold ? self::FONT_BOLD : self::FONT_REGULAR,
            'leading' => $leading,
            'color' => $color ?? [0.10, 0.15, 0.22],
        ];
        return $this;
    }

    /** Regular paragraph text with automatic word wrapping. */
    public function paragraph(string $text, float $size = 9.5): self
    {
        foreach (preg_split('/\R/u', $text) ?: [$text] as $sourceLine) {
            if (trim($sourceLine) === '') {
                $this->spacer(5);
                continue;
            }
            foreach ($this->wrap($sourceLine, $size) as $line) {
                $this->elements[] = [
                    'type' => 'text',
                    'text' => $line,
                    'size' => $size,
                    'font' => self::FONT_REGULAR,
                    'leading' => $size * 1.45,
                    'color' => [0.15, 0.20, 0.28],
                ];
            }
        }
        $this->spacer(4);
        return $this;
    }

    /** A "Label: Value" row (Label in bold, Value in regular). */
    public function keyValue(string $label, string $value, float $size = 9.5): self
    {
        $fullText = $label . ': ' . $value;
        foreach ($this->wrap($fullText, $size) as $index => $line) {
            $this->elements[] = [
                'type' => 'text',
                'text' => $line,
                'size' => $size,
                'font' => $index === 0 ? self::FONT_BOLD : self::FONT_REGULAR,
                'leading' => $size * 1.45,
                'color' => [0.15, 0.20, 0.28],
            ];
        }
        return $this;
    }

    /** Vertical spacing in points. */
    public function spacer(float $points = 8.0): self
    {
        $this->elements[] = ['type' => 'spacer', 'leading' => $points];
        return $this;
    }

    /** True vector horizontal line across the page width. */
    public function rule(float $thickness = 0.75, array $color = [0.80, 0.84, 0.90], float $leading = 10.0): self
    {
        $this->elements[] = [
            'type' => 'rule',
            'thickness' => $thickness,
            'color' => $color,
            'leading' => $leading,
        ];
        return $this;
    }

    /** Full-width filled colored section banner with crisp text. */
    public function banner(string $text, float $size = 10.0, array $bgColor = [0.12, 0.23, 0.43], array $textColor = [1.0, 1.0, 1.0], float $height = 20.0, float $leading = 25.0): self
    {
        $this->elements[] = [
            'type' => 'banner',
            'text' => $text,
            'size' => $size,
            'bgColor' => $bgColor,
            'textColor' => $textColor,
            'height' => $height,
            'leading' => $leading,
        ];
        return $this;
    }

    /** Table header with filled slate background and bold column titles. */
    public function tableHeader(array $headers, array $widths, array $aligns = [], float $size = 8.5, float $leading = 19.0): self
    {
        $this->elements[] = [
            'type' => 'table_header',
            'headers' => $headers,
            'widths' => $widths,
            'aligns' => $aligns,
            'size' => $size,
            'leading' => $leading,
        ];
        return $this;
    }

    /** Table row with exact column alignment and subtle bottom divider. */
    public function tableRow(array $cells, array $widths, array $aligns = [], bool $isBold = false, bool $isTotal = false, float $size = 8.5, float $leading = 16.0): self
    {
        $this->elements[] = [
            'type' => 'table_row',
            'cells' => $cells,
            'widths' => $widths,
            'aligns' => $aligns,
            'isBold' => $isBold,
            'isTotal' => $isTotal,
            'size' => $size,
            'leading' => $leading,
        ];
        return $this;
    }

    /** Row of 2 to 4 executive KPI cards side-by-side. */
    public function kpiGrid(array $cards, float $leading = 48.0): self
    {
        $this->elements[] = [
            'type' => 'kpi_grid',
            'cards' => $cards,
            'leading' => $leading,
        ];
        return $this;
    }

    /** Dual side-by-side signature block for Desk Officer and Punong Barangay. */
    public function signatureBlock(
        string $leftTitle,
        string $leftName,
        string $leftRole,
        string $rightTitle,
        string $rightName,
        string $rightRole,
        float $leading = 60.0
    ): self {
        $this->elements[] = [
            'type' => 'signatures',
            'left' => ['title' => $leftTitle, 'name' => $leftName, 'role' => $leftRole],
            'right' => ['title' => $rightTitle, 'name' => $rightName, 'role' => $rightRole],
            'leading' => $leading,
        ];
        return $this;
    }

    /** Centered navy pill badge matching `.print-sheet__doctype` in the preview modal. */
    public function pillBadge(string $text, float $size = 7.5, float $leading = 20.0): self
    {
        $this->elements[] = [
            'type' => 'pill_badge',
            'text' => $text,
            'size' => $size,
            'leading' => $leading,
        ];
        return $this;
    }

    /**
     * Unified 4-column horizontal metadata bar matching `.print-sheet__meta-bar`.
     *
     * @param array<int, array{label:string, value:string}> $items
     */
    public function metaBar(array $items, float $leading = 42.0): self
    {
        $this->elements[] = [
            'type' => 'meta_bar',
            'items' => $items,
            'leading' => $leading,
        ];
        return $this;
    }

    /**
     * Two side-by-side Party cards with left accent borders matching `.print-sheet__parties`.
     *
     * @param array{role:string, name:string, sub:string} $left
     * @param array{role:string, name:string, sub:string} $right
     */
    public function partyCards(array $left, array $right, float $leading = 58.0): self
    {
        $this->elements[] = [
            'type' => 'party_cards',
            'left' => $left,
            'right' => $right,
            'leading' => $leading,
        ];
        return $this;
    }

    /**
     * Two side-by-side light-slate field boxes matching `.print-sheet__grid-2col`.
     *
     * @param array{label:string, value:string} $left
     * @param array{label:string, value:string} $right
     */
    public function twoColFields(array $left, array $right, float $leading = 44.0): self
    {
        $this->elements[] = [
            'type' => 'two_col_fields',
            'left' => $left,
            'right' => $right,
            'leading' => $leading,
        ];
        return $this;
    }

    /**
     * Uppercase muted label + bordered callout box with a navy left accent bar,
     * matching `.print-sheet__section` + `.print-sheet__narrative`.
     */
    public function calloutSection(string $label, string $body, float $size = 9.0): self
    {
        $usableWidth = self::PAGE_WIDTH - (2 * self::MARGIN) - 24.0;
        $maxChars = max(12, (int) floor($usableWidth / ($size * self::AVG_ADVANCE_RATIO)));

        $lines = [];
        foreach (preg_split('/\R/u', trim($body)) ?: [$body] as $para) {
            if (trim($para) === '') {
                $lines[] = '';
                continue;
            }
            $words = preg_split('/\s+/u', trim($para)) ?: [];
            $current = '';
            foreach ($words as $word) {
                while (mb_strlen($word) > $maxChars) {
                    if ($current !== '') {
                        $lines[] = $current;
                        $current = '';
                    }
                    $lines[] = mb_substr($word, 0, $maxChars);
                    $word = mb_substr($word, $maxChars);
                }
                $candidate = $current === '' ? $word : $current . ' ' . $word;
                if (mb_strlen($candidate) <= $maxChars) {
                    $current = $candidate;
                } else {
                    if ($current !== '') {
                        $lines[] = $current;
                    }
                    $current = $word;
                }
            }
            if ($current !== '') {
                $lines[] = $current;
            }
        }
        if ($lines === []) {
            $lines = [''];
        }

        $lineStep = $size * 1.48;
        $boxHeight = max(28.0, (count($lines) * $lineStep) + 16.0);
        $totalLeading = 13.0 + $boxHeight + 10.0;

        $this->elements[] = [
            'type' => 'callout_section',
            'label' => $label,
            'lines' => $lines,
            'size' => $size,
            'lineStep' => $lineStep,
            'boxHeight' => $boxHeight,
            'leading' => $totalLeading,
        ];
        return $this;
    }

    /** Centered two-column signature block matching `.print-sheet__signatures`. */
    public function centeredSignatures(
        string $leftName,
        string $leftRole,
        string $rightName,
        string $rightRole,
        float $leading = 62.0
    ): self {
        $this->elements[] = [
            'type' => 'centered_signatures',
            'left' => ['name' => $leftName, 'role' => $leftRole],
            'right' => ['name' => $rightName, 'role' => $rightRole],
            'leading' => $leading,
        ];
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

            $stream = $this->contentStream($pages[$i], $i, $pageCount);
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
     * Splits the accumulated elements into pages that fit the printable area.
     *
     * @return array<int, array<int, array<string, mixed>>>
     */
    private function paginate(): array
    {
        // 841.89 (A4) - 54 (top margin) - 60 (bottom margin + footer) = 727.89 pt
        $usableHeight = 720.0;
        $pages = [];
        $current = [];
        $used = 0.0;

        foreach ($this->elements as $elem) {
            $leading = (float) ($elem['leading'] ?? 14.0);
            if ($used + $leading > $usableHeight && $current !== []) {
                $pages[] = $current;
                $current = [];
                $used = 0.0;
                // If a spacer is right at the page break boundary, omit it
                if (($elem['type'] ?? '') === 'spacer') {
                    continue;
                }
            }
            $current[] = $elem;
            $used += $leading;
        }
        if ($current !== []) {
            $pages[] = $current;
        }

        return $pages === [] ? [[]] : $pages;
    }

    /**
     * Builds the PDF content stream for a single page with graphics,
     * tabular alignment, and running headers/footers.
     *
     * @param array<int, array<string, mixed>> $elements
     */
    private function contentStream(array $elements, int $pageNum, int $pageCount): string
    {
        $stream = '';
        $contentWidth = self::PAGE_WIDTH - (2 * self::MARGIN);

        // 1. Running Header (Page 2 onwards)
        if ($pageNum > 0) {
            // Subtle header rule
            $stream .= sprintf(
                "q 0.50 w 0.80 0.84 0.90 RG %.2f 804.00 m %.2f 804.00 l S Q\n",
                self::MARGIN, self::PAGE_WIDTH - self::MARGIN
            );
            // Header text left
            $stream .= sprintf(
                "q 0.38 0.44 0.54 rg BT /%s 7.50 Tf %.2f 809.00 Td (%s) Tj ET Q\n",
                self::FONT_BOLD, self::MARGIN,
                self::escape(self::toWinAnsi('BARANGUARD OFFICIAL RECORD | ' . strtoupper($this->title)))
            );
            // Header text right
            $rightHdr = 'OFFICIAL COPY';
            $rw = mb_strlen($rightHdr) * 7.5 * self::AVG_ADVANCE_RATIO;
            $stream .= sprintf(
                "q 0.50 0.55 0.65 rg BT /%s 7.00 Tf %.2f 809.00 Td (%s) Tj ET Q\n",
                self::FONT_REGULAR, self::PAGE_WIDTH - self::MARGIN - $rw,
                self::escape(self::toWinAnsi($rightHdr))
            );
        }

        // 2. Running Footer (All pages)
        // Footer top rule
        $stream .= sprintf(
            "q 0.50 w 0.82 0.86 0.92 RG %.2f 42.00 m %.2f 42.00 l S Q\n",
            self::MARGIN, self::PAGE_WIDTH - self::MARGIN
        );
        // Footer left notice
        $stream .= sprintf(
            "q 0.45 0.50 0.58 rg BT /%s 6.50 Tf %.2f 30.00 Td (%s) Tj ET Q\n",
            self::FONT_REGULAR, self::MARGIN,
            self::escape(self::toWinAnsi('CONFIDENTIAL - BARANGAY OFFICIAL RECORD - NOT FOR PUBLIC REDISTRIBUTION'))
        );
        // Footer right: Page X of Y
        $pageStr = sprintf('Page %d of %d', $pageNum + 1, $pageCount);
        $pw = mb_strlen($pageStr) * 7.5 * self::AVG_ADVANCE_RATIO;
        $stream .= sprintf(
            "q 0.20 0.25 0.35 rg BT /%s 7.50 Tf %.2f 30.00 Td (%s) Tj ET Q\n",
            self::FONT_BOLD, self::PAGE_WIDTH - self::MARGIN - $pw,
            self::escape(self::toWinAnsi($pageStr))
        );

        // 3. Body Elements
        $y = self::PAGE_HEIGHT - self::MARGIN;

        foreach ($elements as $elem) {
            $type = $elem['type'] ?? '';
            $leading = (float) ($elem['leading'] ?? 14.0);

            switch ($type) {
                case 'text':
                    $size = (float) ($elem['size'] ?? 9.5);
                    $font = (string) ($elem['font'] ?? self::FONT_REGULAR);
                    $color = $elem['color'] ?? [0.15, 0.20, 0.28];
                    $baseline = $y - $size;
                    $stream .= sprintf(
                        "q %.2f %.2f %.2f rg BT /%s %.2f Tf %.2f %.2f Td (%s) Tj ET Q\n",
                        $color[0], $color[1], $color[2],
                        $font, $size,
                        self::MARGIN, $baseline,
                        self::escape(self::toWinAnsi((string) $elem['text']))
                    );
                    $y -= $leading;
                    break;

                case 'center':
                    $size = (float) ($elem['size'] ?? 10.0);
                    $font = (string) ($elem['font'] ?? self::FONT_REGULAR);
                    $color = $elem['color'] ?? [0.10, 0.15, 0.22];
                    $text = (string) $elem['text'];
                    $textW = self::estimateWidth($text, $size, $font === self::FONT_BOLD);
                    $x = max(self::MARGIN, (self::PAGE_WIDTH - $textW) / 2.0);
                    $baseline = $y - $size;
                    $stream .= sprintf(
                        "q %.2f %.2f %.2f rg BT /%s %.2f Tf %.2f %.2f Td (%s) Tj ET Q\n",
                        $color[0], $color[1], $color[2],
                        $font, $size,
                        $x, $baseline,
                        self::escape(self::toWinAnsi($text))
                    );
                    $y -= $leading;
                    break;

                case 'spacer':
                    $y -= $leading;
                    break;

                case 'rule':
                    $thickness = (float) ($elem['thickness'] ?? 0.75);
                    $color = $elem['color'] ?? [0.80, 0.84, 0.90];
                    $ruleY = $y - ($leading / 2);
                    $stream .= sprintf(
                        "q %.2f w %.2f %.2f %.2f RG %.2f %.2f m %.2f %.2f l S Q\n",
                        $thickness,
                        $color[0], $color[1], $color[2],
                        self::MARGIN, $ruleY,
                        self::PAGE_WIDTH - self::MARGIN, $ruleY
                    );
                    $y -= $leading;
                    break;

                case 'banner':
                    $size = (float) ($elem['size'] ?? 10.0);
                    $height = (float) ($elem['height'] ?? 20.0);
                    $bg = $elem['bgColor'] ?? [0.12, 0.23, 0.43];
                    $tc = $elem['textColor'] ?? [1.0, 1.0, 1.0];
                    $boxY = $y - $height;
                    // Filled rectangle
                    $stream .= sprintf(
                        "q %.2f %.2f %.2f rg %.2f %.2f %.2f %.2f re f Q\n",
                        $bg[0], $bg[1], $bg[2],
                        self::MARGIN, $boxY, $contentWidth, $height
                    );
                    // Text
                    $baseline = $boxY + (($height - $size) / 2) + 2.0;
                    $stream .= sprintf(
                        "q %.2f %.2f %.2f rg BT /%s %.2f Tf %.2f %.2f Td (%s) Tj ET Q\n",
                        $tc[0], $tc[1], $tc[2],
                        self::FONT_BOLD, $size,
                        self::MARGIN + 8.0, $baseline,
                        self::escape(self::toWinAnsi((string) $elem['text']))
                    );
                    $y -= $leading;
                    break;

                case 'table_header':
                    $headers = (array) ($elem['headers'] ?? []);
                    $widths = (array) ($elem['widths'] ?? []);
                    $aligns = (array) ($elem['aligns'] ?? []);
                    $size = (float) ($elem['size'] ?? 8.5);
                    $rowH = $leading;
                    $boxY = $y - $rowH;

                    $colWidths = [];
                    $totalW = array_sum($widths);
                    foreach ($widths as $w) {
                        $colWidths[] = ($totalW <= 1.05) ? ($w * $contentWidth) : (float) $w;
                    }

                    // Header row background (Dark Navy #1E3A8A)
                    $stream .= sprintf(
                        "q 0.12 0.23 0.43 rg %.2f %.2f %.2f %.2f re f Q\n",
                        self::MARGIN, $boxY, $contentWidth, $rowH
                    );

                    $baseline = $boxY + (($rowH - $size) / 2) + 2.0;
                    $currX = self::MARGIN;
                    foreach ($headers as $idx => $hdr) {
                        $w = $colWidths[$idx] ?? 60.0;
                        $align = $aligns[$idx] ?? 'left';
                        $cellText = (string) $hdr;
                        $cellW = mb_strlen($cellText) * $size * self::AVG_ADVANCE_RATIO;
                        if ($align === 'right') {
                            $tx = $currX + $w - $cellW - 6.0;
                        } elseif ($align === 'center') {
                            $tx = $currX + ($w - $cellW) / 2;
                        } else {
                            $tx = $currX + 6.0;
                        }
                        $stream .= sprintf(
                            "q 1.00 1.00 1.00 rg BT /%s %.2f Tf %.2f %.2f Td (%s) Tj ET Q\n",
                            self::FONT_BOLD, $size,
                            $tx, $baseline,
                            self::escape(self::toWinAnsi($cellText))
                        );
                        $currX += $w;
                    }
                    $y -= $leading;
                    break;

                case 'table_row':
                    $cells = (array) ($elem['cells'] ?? []);
                    $widths = (array) ($elem['widths'] ?? []);
                    $aligns = (array) ($elem['aligns'] ?? []);
                    $isBold = !empty($elem['isBold']);
                    $isTotal = !empty($elem['isTotal']);
                    $size = (float) ($elem['size'] ?? 8.5);
                    $rowH = $leading;
                    $boxY = $y - $rowH;

                    $colWidths = [];
                    $totalW = array_sum($widths);
                    foreach ($widths as $w) {
                        $colWidths[] = ($totalW <= 1.05) ? ($w * $contentWidth) : (float) $w;
                    }

                    // Total row gets highlighted background and top divider
                    if ($isTotal) {
                        $stream .= sprintf(
                            "q 0.93 0.95 0.98 rg %.2f %.2f %.2f %.2f re f Q\n",
                            self::MARGIN, $boxY, $contentWidth, $rowH
                        );
                        $stream .= sprintf(
                            "q 0.75 w 0.12 0.23 0.43 RG %.2f %.2f m %.2f %.2f l S Q\n",
                            self::MARGIN, $y, self::PAGE_WIDTH - self::MARGIN, $y
                        );
                    }

                    // Bottom divider line for every row
                    $stream .= sprintf(
                        "q 0.50 w 0.88 0.90 0.94 RG %.2f %.2f m %.2f %.2f l S Q\n",
                        self::MARGIN, $boxY, self::PAGE_WIDTH - self::MARGIN, $boxY
                    );

                    $font = ($isBold || $isTotal) ? self::FONT_BOLD : self::FONT_REGULAR;
                    $c = $isTotal ? [0.08, 0.14, 0.28] : ($isBold ? [0.12, 0.18, 0.26] : [0.20, 0.24, 0.30]);
                    $baseline = $boxY + (($rowH - $size) / 2) + 2.0;

                    $currX = self::MARGIN;
                    foreach ($cells as $idx => $cell) {
                        $w = $colWidths[$idx] ?? 60.0;
                        $align = $aligns[$idx] ?? 'left';
                        $cellText = (string) $cell;
                        $cellW = mb_strlen($cellText) * $size * self::AVG_ADVANCE_RATIO;
                        if ($align === 'right') {
                            $tx = $currX + $w - $cellW - 6.0;
                        } elseif ($align === 'center') {
                            $tx = $currX + ($w - $cellW) / 2;
                        } else {
                            $tx = $currX + 6.0;
                        }
                        $stream .= sprintf(
                            "q %.2f %.2f %.2f rg BT /%s %.2f Tf %.2f %.2f Td (%s) Tj ET Q\n",
                            $c[0], $c[1], $c[2],
                            $font, $size,
                            $tx, $baseline,
                            self::escape(self::toWinAnsi($cellText))
                        );
                        $currX += $w;
                    }
                    $y -= $leading;
                    break;

                case 'kpi_grid':
                    $cards = (array) ($elem['cards'] ?? []);
                    $cardCount = max(1, count($cards));
                    $gap = 10.0;
                    $cardW = ($contentWidth - (($cardCount - 1) * $gap)) / $cardCount;
                    $cardH = 44.0;
                    $boxY = $y - $cardH;

                    $currX = self::MARGIN;
                    foreach ($cards as $card) {
                        // Background
                        $stream .= sprintf(
                            "q 0.96 0.97 0.99 rg %.2f %.2f %.2f %.2f re f Q\n",
                            $currX, $boxY, $cardW, $cardH
                        );
                        // Border stroke
                        $stream .= sprintf(
                            "q 0.75 w 0.82 0.86 0.92 RG %.2f %.2f %.2f %.2f re s Q\n",
                            $currX, $boxY, $cardW, $cardH
                        );
                        // Left accent strip
                        $stream .= sprintf(
                            "q 0.12 0.35 0.70 rg %.2f %.2f 3.50 %.2f re f Q\n",
                            $currX, $boxY, $cardH
                        );

                        // Card label (top)
                        $lblY = $boxY + $cardH - 12.0;
                        $lblText = strtoupper((string) ($card['label'] ?? ''));
                        $stream .= sprintf(
                            "q 0.40 0.46 0.54 rg BT /%s 7.00 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                            self::FONT_BOLD,
                            $currX + 8.0, $lblY,
                            self::escape(self::toWinAnsi($lblText))
                        );

                        // Card big value (middle)
                        $valY = $boxY + 16.0;
                        $valText = (string) ($card['value'] ?? '0');
                        $valLen = mb_strlen($valText);
                        $valFontSize = $valLen > 16 ? 8.50 : ($valLen > 11 ? 10.50 : 14.50);
                        $stream .= sprintf(
                            "q 0.08 0.16 0.32 rg BT /%s %.2f Tf %.2f %.2f Td (%s) Tj ET Q\n",
                            self::FONT_BOLD, $valFontSize,
                            $currX + 8.0, $valY,
                            self::escape(self::toWinAnsi($valText))
                        );

                        // Card subtitle (bottom)
                        if (!empty($card['sub'])) {
                            $subY = $boxY + 5.0;
                            $stream .= sprintf(
                                "q 0.45 0.52 0.60 rg BT /%s 6.80 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                                self::FONT_REGULAR,
                                $currX + 8.0, $subY,
                                self::escape(self::toWinAnsi((string) $card['sub']))
                            );
                        }

                        $currX += $cardW + $gap;
                    }
                    $y -= $leading;
                    break;

                case 'signatures':
                    $left = (array) ($elem['left'] ?? []);
                    $right = (array) ($elem['right'] ?? []);
                    $colW = 200.0;
                    $leftX = self::MARGIN;
                    $rightX = self::PAGE_WIDTH - self::MARGIN - $colW;

                    // Section titles
                    $titleY = $y - 10.0;
                    $stream .= sprintf(
                        "q 0.35 0.40 0.48 rg BT /%s 8.00 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                        self::FONT_BOLD, $leftX, $titleY,
                        self::escape(self::toWinAnsi(strtoupper((string) ($left['title'] ?? 'PREPARED BY:'))))
                    );
                    $stream .= sprintf(
                        "q 0.35 0.40 0.48 rg BT /%s 8.00 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                        self::FONT_BOLD, $rightX, $titleY,
                        self::escape(self::toWinAnsi(strtoupper((string) ($right['title'] ?? 'ATTESTED BY:'))))
                    );

                    // Signature line
                    $lineY = $y - 38.0;
                    $stream .= sprintf(
                        "q 0.75 w 0.20 0.24 0.30 RG %.2f %.2f m %.2f %.2f l S Q\n",
                        $leftX, $lineY, $leftX + 180.0, $lineY
                    );
                    $stream .= sprintf(
                        "q 0.75 w 0.20 0.24 0.30 RG %.2f %.2f m %.2f %.2f l S Q\n",
                        $rightX, $lineY, $rightX + 180.0, $lineY
                    );

                    // Names (Bold)
                    $nameY = $lineY - 11.0;
                    $stream .= sprintf(
                        "q 0.10 0.15 0.25 rg BT /%s 9.50 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                        self::FONT_BOLD, $leftX, $nameY,
                        self::escape(self::toWinAnsi((string) ($left['name'] ?? '')))
                    );
                    $stream .= sprintf(
                        "q 0.10 0.15 0.25 rg BT /%s 9.50 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                        self::FONT_BOLD, $rightX, $nameY,
                        self::escape(self::toWinAnsi((string) ($right['name'] ?? '')))
                    );

                    // Roles (Regular)
                    $roleY = $nameY - 10.0;
                    $stream .= sprintf(
                        "q 0.35 0.40 0.48 rg BT /%s 8.00 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                        self::FONT_REGULAR, $leftX, $roleY,
                        self::escape(self::toWinAnsi((string) ($left['role'] ?? '')))
                    );
                    $stream .= sprintf(
                        "q 0.35 0.40 0.48 rg BT /%s 8.00 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                        self::FONT_REGULAR, $rightX, $roleY,
                        self::escape(self::toWinAnsi((string) ($right['role'] ?? '')))
                    );

                    $y -= $leading;
                    break;

                case 'pill_badge':
                    $text = (string) ($elem['text'] ?? '');
                    $size = (float) ($elem['size'] ?? 7.5);
                    $textW = self::estimateWidth($text, $size, true);
                    $pillW = $textW + 24.0;
                    $pillH = 15.0;
                    $pillX = (self::PAGE_WIDTH - $pillW) / 2.0;
                    $pillY = $y - $pillH;

                    // Navy pill fill (#1E3A6E)
                    $stream .= sprintf(
                        "q 0.12 0.23 0.43 rg %.2f %.2f %.2f %.2f re f Q\n",
                        $pillX, $pillY, $pillW, $pillH
                    );
                    $baseline = $pillY + (($pillH - $size) / 2.0) + 1.5;
                    $tx = (self::PAGE_WIDTH - $textW) / 2.0;
                    $stream .= sprintf(
                        "q 1.00 1.00 1.00 rg BT /%s %.2f Tf %.2f %.2f Td (%s) Tj ET Q\n",
                        self::FONT_BOLD, $size, $tx, $baseline,
                        self::escape(self::toWinAnsi($text))
                    );
                    $y -= $leading;
                    break;

                case 'meta_bar':
                    $items = (array) ($elem['items'] ?? []);
                    $count = max(1, count($items));
                    $barH = 34.0;
                    $boxY = $y - $barH;
                    $colW = $contentWidth / $count;

                    // Subtle slate background (#F8FAFC) + border (#CBD5E1)
                    $stream .= sprintf(
                        "q 0.97 0.98 0.99 rg %.2f %.2f %.2f %.2f re f Q\n",
                        self::MARGIN, $boxY, $contentWidth, $barH
                    );
                    $stream .= sprintf(
                        "q 0.75 w 0.80 0.84 0.88 RG %.2f %.2f %.2f %.2f re s Q\n",
                        self::MARGIN, $boxY, $contentWidth, $barH
                    );

                    foreach ($items as $idx => $item) {
                        $cx = self::MARGIN + ($idx * $colW) + 10.0;
                        $lbl = strtoupper((string) ($item['label'] ?? ''));
                        $val = (string) ($item['value'] ?? '');

                        // Uppercase muted label
                        $stream .= sprintf(
                            "q 0.28 0.33 0.41 rg BT /%s 6.80 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                            self::FONT_BOLD, $cx, $boxY + 21.5,
                            self::escape(self::toWinAnsi($lbl))
                        );

                        // Bold value (navy for first cell, dark ink for others)
                        $vc = $idx === 0 ? [0.12, 0.23, 0.43] : [0.06, 0.09, 0.16];
                        $stream .= sprintf(
                            "q %.2f %.2f %.2f rg BT /%s 8.80 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                            $vc[0], $vc[1], $vc[2],
                            self::FONT_BOLD, $cx, $boxY + 8.5,
                            self::escape(self::toWinAnsi($val))
                        );
                    }
                    $y -= $leading;
                    break;

                case 'party_cards':
                    $left = (array) ($elem['left'] ?? []);
                    $right = (array) ($elem['right'] ?? []);
                    $gap = 12.0;
                    $cardW = ($contentWidth - $gap) / 2.0;
                    $cardH = 50.0;
                    $boxY = $y - $cardH;

                    $pair = [
                        ['x' => self::MARGIN, 'data' => $left, 'accent' => [0.12, 0.23, 0.43]],
                        ['x' => self::MARGIN + $cardW + $gap, 'data' => $right, 'accent' => [0.28, 0.33, 0.41]],
                    ];
                    foreach ($pair as $p) {
                        $cx = $p['x'];
                        $d = $p['data'];
                        $ac = $p['accent'];

                        // White card + border + left accent bar
                        $stream .= sprintf(
                            "q 1.00 1.00 1.00 rg %.2f %.2f %.2f %.2f re f Q\n",
                            $cx, $boxY, $cardW, $cardH
                        );
                        $stream .= sprintf(
                            "q 0.75 w 0.80 0.84 0.88 RG %.2f %.2f %.2f %.2f re s Q\n",
                            $cx, $boxY, $cardW, $cardH
                        );
                        $stream .= sprintf(
                            "q %.2f %.2f %.2f rg %.2f %.2f 3.50 %.2f re f Q\n",
                            $ac[0], $ac[1], $ac[2], $cx, $boxY, $cardH
                        );

                        // Role label
                        $stream .= sprintf(
                            "q 0.28 0.33 0.41 rg BT /%s 6.80 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                            self::FONT_BOLD, $cx + 10.0, $boxY + 37.5,
                            self::escape(self::toWinAnsi(strtoupper((string) ($d['role'] ?? ''))))
                        );
                        // Party name
                        $stream .= sprintf(
                            "q 0.06 0.09 0.16 rg BT /%s 10.20 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                            self::FONT_BOLD, $cx + 10.0, $boxY + 22.5,
                            self::escape(self::toWinAnsi((string) ($d['name'] ?? '')))
                        );
                        // Sub-line
                        $stream .= sprintf(
                            "q 0.28 0.33 0.41 rg BT /%s 7.80 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                            self::FONT_REGULAR, $cx + 10.0, $boxY + 9.0,
                            self::escape(self::toWinAnsi((string) ($d['sub'] ?? '')))
                        );
                    }
                    $y -= $leading;
                    break;

                case 'two_col_fields':
                    $left = (array) ($elem['left'] ?? []);
                    $right = (array) ($elem['right'] ?? []);
                    $gap = 12.0;
                    $boxW = ($contentWidth - $gap) / 2.0;
                    $boxH = 36.0;
                    $boxY = $y - $boxH;

                    $pair = [
                        ['x' => self::MARGIN, 'data' => $left],
                        ['x' => self::MARGIN + $boxW + $gap, 'data' => $right],
                    ];
                    foreach ($pair as $p) {
                        $cx = $p['x'];
                        $d = $p['data'];

                        $stream .= sprintf(
                            "q 0.97 0.98 0.99 rg %.2f %.2f %.2f %.2f re f Q\n",
                            $cx, $boxY, $boxW, $boxH
                        );
                        $stream .= sprintf(
                            "q 0.75 w 0.80 0.84 0.88 RG %.2f %.2f %.2f %.2f re s Q\n",
                            $cx, $boxY, $boxW, $boxH
                        );

                        $stream .= sprintf(
                            "q 0.28 0.33 0.41 rg BT /%s 6.80 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                            self::FONT_BOLD, $cx + 10.0, $boxY + 23.0,
                            self::escape(self::toWinAnsi(strtoupper((string) ($d['label'] ?? ''))))
                        );

                        $valText = (string) ($d['value'] ?? '');
                        if (mb_strlen($valText) > 52) {
                            $valText = mb_substr($valText, 0, 49) . '...';
                        }
                        $stream .= sprintf(
                            "q 0.06 0.09 0.16 rg BT /%s 8.60 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                            self::FONT_REGULAR, $cx + 10.0, $boxY + 9.5,
                            self::escape(self::toWinAnsi($valText))
                        );
                    }
                    $y -= $leading;
                    break;

                case 'callout_section':
                    $label = strtoupper((string) ($elem['label'] ?? ''));
                    $lines = (array) ($elem['lines'] ?? []);
                    $size = (float) ($elem['size'] ?? 9.0);
                    $lineStep = (float) ($elem['lineStep'] ?? ($size * 1.48));
                    $boxH = (float) ($elem['boxHeight'] ?? 32.0);

                    // Section label above box
                    $lblY = $y - 9.0;
                    $stream .= sprintf(
                        "q 0.28 0.33 0.41 rg BT /%s 7.20 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                        self::FONT_BOLD, self::MARGIN, $lblY,
                        self::escape(self::toWinAnsi($label))
                    );

                    $boxY = $y - 13.0 - $boxH;
                    // Box background (#F8FAFC) + border (#CBD5E1) + left navy strip (#1E3A6E)
                    $stream .= sprintf(
                        "q 0.97 0.98 0.99 rg %.2f %.2f %.2f %.2f re f Q\n",
                        self::MARGIN, $boxY, $contentWidth, $boxH
                    );
                    $stream .= sprintf(
                        "q 0.75 w 0.80 0.84 0.88 RG %.2f %.2f %.2f %.2f re s Q\n",
                        self::MARGIN, $boxY, $contentWidth, $boxH
                    );
                    $stream .= sprintf(
                        "q 0.12 0.23 0.43 rg %.2f %.2f 3.00 %.2f re f Q\n",
                        self::MARGIN, $boxY, $boxH
                    );

                    $lineY = $boxY + $boxH - 11.0 - ($size * 0.45);
                    foreach ($lines as $ln) {
                        if ($ln !== '') {
                            $stream .= sprintf(
                                "q 0.06 0.09 0.16 rg BT /%s %.2f Tf %.2f %.2f Td (%s) Tj ET Q\n",
                                self::FONT_REGULAR, $size, self::MARGIN + 11.0, $lineY,
                                self::escape(self::toWinAnsi((string) $ln))
                            );
                        }
                        $lineY -= $lineStep;
                    }

                    $y -= $leading;
                    break;

                case 'centered_signatures':
                    $left = (array) ($elem['left'] ?? []);
                    $right = (array) ($elem['right'] ?? []);
                    $colW = 210.0;
                    $leftX = self::MARGIN + 10.0;
                    $rightX = self::PAGE_WIDTH - self::MARGIN - $colW - 10.0;
                    $lineY = $y - 24.0;

                    foreach ([['x' => $leftX, 'd' => $left], ['x' => $rightX, 'd' => $right]] as $sig) {
                        $sx = $sig['x'];
                        $sd = $sig['d'];

                        // Signature line
                        $stream .= sprintf(
                            "q 0.85 w 0.06 0.09 0.16 RG %.2f %.2f m %.2f %.2f l S Q\n",
                            $sx, $lineY, $sx + $colW, $lineY
                        );

                        // Centered bold name
                        $nameStr = (string) ($sd['name'] ?? '');
                        $nameW = self::estimateWidth($nameStr, 8.5, true);
                        $nx = $sx + max(0.0, ($colW - $nameW) / 2.0);
                        $stream .= sprintf(
                            "q 0.06 0.09 0.16 rg BT /%s 8.50 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                            self::FONT_BOLD, $nx, $lineY - 11.5,
                            self::escape(self::toWinAnsi($nameStr))
                        );

                        // Centered muted role
                        $roleStr = (string) ($sd['role'] ?? '');
                        $roleW = self::estimateWidth($roleStr, 7.2, false);
                        $rx = $sx + max(0.0, ($colW - $roleW) / 2.0);
                        $stream .= sprintf(
                            "q 0.28 0.33 0.41 rg BT /%s 7.20 Tf %.2f %.2f Td (%s) Tj ET Q\n",
                            self::FONT_REGULAR, $rx, $lineY - 21.5,
                            self::escape(self::toWinAnsi($roleStr))
                        );
                    }
                    $y -= $leading;
                    break;

                default:
                    $y -= $leading;
                    break;
            }
        }

        return $stream;
    }

    /**
     * Estimates Helvetica string width in points by character class so
     * centered uppercase headings, pill badges, and mixed-case lines
     * center accurately without embedding a full metrics table.
     */
    private static function estimateWidth(string $text, float $size, bool $bold = false): float
    {
        $ems = 0.0;
        $chars = preg_split('//u', $text, -1, PREG_SPLIT_NO_EMPTY) ?: [];
        foreach ($chars as $ch) {
            if ($ch === ' ' || $ch === '.' || $ch === ',' || $ch === ':' || $ch === ';' || $ch === '\'' || $ch === '!' || $ch === '|') {
                $ems += 0.28;
            } elseif ($ch === '-' || $ch === '(' || $ch === ')' || $ch === '/') {
                $ems += 0.33;
            } elseif ($ch === 'I' || $ch === 'J' || $ch === 'l' || $ch === 'i' || $ch === 't' || $ch === 'f' || $ch === 'r') {
                $ems += 0.34;
            } elseif ($ch === 'M' || $ch === 'W' || $ch === 'm' || $ch === 'w') {
                $ems += 0.82;
            } elseif ($ch >= 'A' && $ch <= 'Z') {
                $ems += 0.67;
            } elseif ($ch >= '0' && $ch <= '9') {
                $ems += 0.56;
            } else {
                $ems += 0.52;
            }
        }
        return $ems * $size * ($bold ? 1.05 : 1.0);
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
