import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import {
  inlineClipboardStyles,
  StyledTable,
  StyledTableRow,
  StyledTableHeader,
  StyledTableCell,
  TablePaste,
} from '../table-paste';

// Trimmed from what Excel 365 on Windows puts on the clipboard for a table
// with a bold, red-headed column and a right-aligned numeric column.
const EXCEL_HTML = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:x="urn:schemas-microsoft-com:office:excel">
<head><meta name=ProgId content=Excel.Sheet><meta name=Generator content="Microsoft Excel 15">
<style>
<!--table
{mso-displayed-decimal-separator:".";
mso-displayed-thousand-separator:",";}
.xl65{font-weight:700;color:WindowText;}
.xl66{background:#FFC7CE;}
td{padding-top:1px;padding-right:1px;}
-->
</style></head>
<body link="#0563C1" vlink="#954F72">
<table border=0 cellpadding=0 cellspacing=0 width=128 style='border-collapse:collapse;width:96pt'>
<col width=64 span=2 style='width:48pt'>
<tr height=20 style='height:15.0pt'>
<!--StartFragment-->
  <td height=20 class=xl65 width=64 style='height:15.0pt;width:48pt'>Name</td>
  <td class=xl66 bgcolor="#DDDDDD" width=64 style='width:48pt'>Qty</td>
 </tr>
 <tr height=20 style='height:15.0pt'>
  <td height=20 style='height:15.0pt'>Apples</td>
  <td align=right>3</td>
<!--EndFragment-->
 </tr>
</table>
</body>
</html>`;

describe('inlineClipboardStyles', () => {
  it('moves class rules and legacy attributes onto the elements as inline styles', () => {
    const html = inlineClipboardStyles(EXCEL_HTML);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cells = Array.from(doc.querySelectorAll('td'));

    expect(cells[0].getAttribute('class')).toBeNull();
    expect(cells[0].style.fontWeight).toBe('700');
    // The td rule survives; the spreadsheet's own width pin is dropped so the
    // column can size to its content (height, a row property, stays).
    expect(cells[0].style.paddingTop).toBe('1px');
    expect(cells[0].style.width).toBe('');
    expect(cells[0].style.height).toBe('15pt');
    // One line per cell, like the spreadsheet grid.
    expect(cells[0].style.whiteSpace).toBe('nowrap');
    // The pasted table carries its own auto layout: the editor stylesheet
    // pins .tiptap table to table-layout:fixed/width:100%, and only an
    // inline auto beats that.
    expect(doc.querySelector('table')!.style.tableLayout).toBe('auto');
    expect(cells[1].style.backgroundColor).toMatch(/#ffc7ce|rgb/i);
    // bgcolor maps to background-color, class rule first, attribute second.
    expect(cells[1].style.backgroundColor).toBeTruthy();
    // Legacy align=right maps to a style the schema's align parser reads.
    expect(cells[3].style.textAlign).toBe('right');
  });
  it('drops declarations outside the property whitelist and dangerous values', () => {
    const html = inlineClipboardStyles(
      `<html><head><style>
      td { font-weight: 700; position: fixed; background: url(https://tracker.example/pixel.png); }
      .evil { behavior: url(#default#time2); color: red; }
      </style></head><body>
      <table><tr><td class="evil" style="color: blue">x</td></tr></table>
      </body></html>`,
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const td = doc.querySelector('td')!;
    expect(td.style.fontWeight).toBe('700');
    expect(td.style.position).toBe('');
    expect(td.style.background).toBe('');
    expect(td.getAttribute('style')).not.toMatch(/behavior|url\(/i);
    // The own inline style still wins over the class rule.
    expect(td.style.color).toBe('blue');
  });

  it('returns non-table HTML and tables without a style block unchanged', () => {
    const plain = '<p>hello</p>';
    expect(inlineClipboardStyles(plain)).toBe(plain);
    const bare = '<table><tr><td>a</td></tr></table>';
    const result = inlineClipboardStyles(bare);
    expect(result).toContain('<td');
    // Nothing to inline, no legacy attributes: only whitespace-level changes.
    expect(new DOMParser().parseFromString(result, 'text/html').querySelector('td')!.textContent).toBe('a');
  });

  it('re-pins pasted tables to an auto layout with one-line cells', () => {
    const html = inlineClipboardStyles(`<html><head><meta name=ProgId content=Excel.Sheet>
<style><!--td{white-space:nowrap;}--></style></head><body>
<table style='table-layout:fixed;width:300pt'>
<tr><td class=xl65 style='white-space:nowrap'>a long cell value</td><td>x</td></tr>
</table></body></html>`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // fixed layout + nowrap is the spill combination; the auto layout that
    // replaces it stretches the column instead, so nowrap is safe again.
    expect(doc.querySelector('table')!.style.tableLayout).toBe('auto');
    expect(doc.querySelector('table')!.getAttribute('style')).not.toMatch(/width/i);
    expect(doc.querySelector('td')!.style.whiteSpace).toBe('nowrap');
  });

  it('drops the spreadsheet column widths so columns size to their content', () => {
    const html = inlineClipboardStyles(`<html><head><meta name=ProgId content=Excel.Sheet></head><body>
<table style='border-collapse:collapse;width:300pt'>
<col width=100><col width=300>
<tr><td style='width:48pt'>a long cell value</td><td>x</td></tr>
</table></body></html>`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // The table width, the col widths, and the cell's own width pin all go:
    // nothing keeps the column at the spreadsheet's grid size.
    expect(doc.querySelector('table')!.getAttribute('style')).not.toMatch(/width/i);
    for (const col of doc.querySelectorAll('col')) {
      expect(col.getAttribute('width')).toBeNull();
      expect(col.getAttribute('style')).toBeNull();
    }
    expect(doc.querySelector('td')!.style.width).toBe('');
    expect(doc.querySelector('td')!.style.whiteSpace).toBe('nowrap');
  });

  it('applies the auto layout even without a style block or ProgId', () => {
    const html = '<table style="table-layout:fixed"><tr><td style="white-space:nowrap">t</td></tr></table>';
    const doc = new DOMParser().parseFromString(inlineClipboardStyles(html), 'text/html');
    expect(doc.querySelector('table')!.style.tableLayout).toBe('auto');
    expect(doc.querySelector('td')!.style.whiteSpace).toBe('nowrap');
  });
});

describe('pasting an Office table into the composer', () => {
  // The composer's own configure() options, so the static fallback styling
  // (borders/padding for tables without their own) is part of the test.
  function makeEditor() {
    return new Editor({
      element: document.createElement('div'),
      extensions: [
        StarterKit,
        StyledTable.configure({
          resizable: true,
          HTMLAttributes: {
            border: "1",
            cellpadding: "6",
            cellspacing: "0",
            width: "100%",
            style: "width:100%;border-collapse:collapse;",
          },
        }),
        StyledTableRow,
        StyledTableHeader.configure({
          HTMLAttributes: {
            style: "padding:6px 8px;border:1px solid #ccc;background-color:#f5f5f5;color:#1f2937;text-align:left;",
          },
        }),
        StyledTableCell.configure({
          HTMLAttributes: {
            style: "padding:6px 8px;border:1px solid #ccc;vertical-align:top;",
          },
        }),
        TablePaste,
      ],
      content: '<p></p>',
    });
  }

  it('keeps the cells and their styling', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(EXCEL_HTML, new Event('paste') as ClipboardEvent);

    const table = editor.view.dom.querySelector('table');
    expect(table).not.toBeNull();
    const cells = Array.from(table!.querySelectorAll('td, th')).map((c) => c.textContent);
    expect(cells).toEqual(['Name', 'Qty', 'Apples', '3']);

    // Table-level style survives the parse (jsdom normalizes hex to rgb),
    // and the pasted table's inline auto layout beats the editor
    // stylesheet's .tiptap table { table-layout: fixed }.
    expect(table!.getAttribute('style')).toMatch(/border-collapse/i);
    expect(table!.style.tableLayout).toBe('auto');
    // Cell-level style from the class rule and the own inline style; the
    // width pin is stripped so the column sizes to its content, and every
    // cell keeps one line.
    expect(cells.length && table!.querySelectorAll('td')[0].style.fontWeight).toBe('700');
    expect(table!.querySelectorAll('td')[0].getAttribute('style')).not.toMatch(/width/i);
    expect(table!.querySelectorAll('td')[0].style.whiteSpace).toBe('nowrap');
    expect(table!.querySelectorAll('td')[1].getAttribute('style')).toMatch(/background/i);
    // Column widths come through the colgroup.
    const cols = table!.querySelectorAll('col');
    expect(cols.length).toBeGreaterThanOrEqual(2);
    editor.destroy();
  });

  it('serializes the styling back out for sending', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(EXCEL_HTML, new Event('paste') as ClipboardEvent);

    const html = editor.getHTML();
    expect(html).toMatch(/<table[^>]*style="[^"]*border-collapse/i);
    expect(html).toMatch(/<table[^>]*style="[^"]*table-layout:\s*auto/i);
    expect(html).toMatch(/<td[^>]*style="[^"]*font-weight/i);
    expect(html).toMatch(/<td[^>]*style="[^"]*white-space:\s*nowrap/i);
    editor.destroy();
  });

  it('renders a plain inserted table with the default styling intact', () => {
    const editor = makeEditor();
    editor.commands.setContent('<table><tr><th>H</th></tr><tr><td>a</td></tr></table>');
    const td = editor.view.dom.querySelector('td')!;
    expect(td.getAttribute('style')).toMatch(/border/i);
    expect(td.getAttribute('style')).toMatch(/padding/i);
    editor.destroy();
  });

  it('keeps merged cells together with their style (addAttributes must not drop colspan)', () => {
    const editor = makeEditor();
    editor.commands.setContent(
      '<table><tr><td colspan="2" rowspan="2" style="background-color: #ffecb3">a</td><td>b</td></tr>'
      + '<tr><td>c</td></tr></table>',
    );
    const merged = editor.state.doc.firstChild!.firstChild!.firstChild!;
    expect(merged.attrs.colspan).toBe(2);
    expect(merged.attrs.rowspan).toBe(2);
    expect(merged.attrs.style).toMatch(/background-color/i);
    editor.destroy();
  });
});
