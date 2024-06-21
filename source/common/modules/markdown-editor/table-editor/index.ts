/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TableRenderer
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Utilizing the TableEditor, this renderer renders tables.
 *
 * END HEADER
 */

// DEBUG // As of now, the new TableEditor has very rudimentary functionality.
// DEBUG // It properly renders tables with basic styles in Markdown documents
// DEBUG // and allows users to click inside tables to start editing. That
// DEBUG // creation and removal of various subviews is a bit wonky right now,
// DEBUG // but any change is immediately applied to the underlying main
// DEBUG // EditorView, ensuring that no changes are retained just within the
// DEBUG // subview.

import { Decoration, DecorationSet, EditorView, WidgetType, drawSelection, keymap } from '@codemirror/view'
import { Range, Transaction, Annotation, EditorState, StateField } from '@codemirror/state'
import { defaultHighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { SyntaxNode } from '@lezer/common'
import { parseTableNode } from "../../markdown-utils/markdown-ast/parse-table-node"
import { TableRow } from '../../markdown-utils/markdown-ast'
import { nodeToHTML } from '../../markdown-utils/markdown-to-html'
import { defaultKeymap } from '@codemirror/commands'

// This syncAnnotation is used to tag all transactions originating from the main
// EditorView when dispatching them to the subview to ensure they don't get re-
// emitted.
const syncAnnotation = Annotation.define<boolean>()

// This widget holds a visual DOM representation of a table.
class TableWidget extends WidgetType {
  constructor (readonly table: string, readonly node: SyntaxNode) {
    super()
  }

  toDOM (view: EditorView): HTMLElement {
    try {
      const table = document.createElement('table')
      table.classList.add('cm-table-editor-widget')
      updateTable(this, table, view)
      return table
    } catch (err: any) {
      console.log('Could not create table', err)
      const error = document.createElement('div')
      error.classList.add('error')
      error.textContent = `Could not render table: ${err.message}`
      return error
    }
  }

  updateDOM (dom: HTMLElement, view: EditorView): boolean {
    // This check allows us to, e.g., create error divs
    if (!(dom instanceof HTMLTableElement)) {
      return false
    }
    updateTable(this, dom, view)
    return true
  }

  destroy (dom: HTMLElement): void {
    // Here we ensure that we completely detach any active subview from the rest
    // of the document so that the garbage collector can remove the subview.
    const cells = [
      ...dom.querySelectorAll('td'),
      ...dom.querySelectorAll('th')
    ]

    for (const cell of cells) {
      const subview = EditorView.findFromDOM(cell)
      if (subview !== null) {
        subview.destroy()
      }
    }
  }

  ignoreEvent (event: Event): boolean {
    return true // In this plugin case, the table should handle everything
  }

  /**
   * Takes an EditorState and returns a DecorationSet containing TableWidgets
   * for each Table node found in the state.
   *
   * @param   {EditorState}    state  The EditorState
   *
   * @return  {DecorationSet}         The DecorationSet
   */
  public static createForState (state: EditorState): DecorationSet {
    const newDecos: Array<Range<Decoration>> = syntaxTree(state)
      // Get all Table nodes in the document
      .topNode.getChildren('Table')
      // Turn the nodes into Decorations
      .map(node => {
        return Decoration.replace({
          widget: new TableWidget(state.sliceDoc(node.from, node.to), node.node),
          // inclusive: false,
          block: true
        }).range(node.from, node.to)
      })
    return Decoration.set(newDecos)
  }
}

// DEBUG: Maybe we won't need that at all...? At least I can actually write
// properly into the table cells. But this is a problem for future me.
/**
 * This function takes an EditorView that is acting as a slave to some main
 * EditorView in which the TableEditor is running and applies all provided
 * transactions one by one to the subview, ensuring to tag the transactions with
 * a syncAnnotation to signal to the subview that it should not re-emit those
 * transactions.
 *
 * @param  {EditorView}   subview  The subview to have the transaction applied to
 * @param  {Transaction}  tr       The transaction from the main view
 */
function maybeUpdateSubview (subview: EditorView, tr: Transaction): void {
  if (!tr.changes.empty && tr.annotation(syncAnnotation) === undefined) {
    const annotations: Annotation<any>[] = [syncAnnotation.of(true)]
    const userEvent = tr.annotation(Transaction.userEvent)
    if (userEvent !== undefined) {
      annotations.push(Transaction.userEvent.of(userEvent))
    }
    subview.dispatch({changes: tr.changes, annotations})
  }
}

/**
 * This function takes a DOM-node and a string representing the same Markdown
 * table and ensures that the DOM-node representation conforms to the string.
 *
 * @param  {TableWidget}       widget  A TableWidget
 * @param  {HTMLTableElement}  table   The DOM-element containing the table
 * @param  {EditorView}        view    The EditorView
 */
function updateTable (widget: TableWidget, table: HTMLTableElement, view: EditorView): void {
  const tableAST = parseTableNode(widget.node, view.state.sliceDoc())

  let trs = [...table.querySelectorAll('tr')]
  if (trs.length > tableAST.rows.length) {
    // Too many TRs --> Remove. The for-loop below accounts for too few.
    for (let j = tableAST.rows.length; j < trs.length; j++) {
      trs[j].parentElement?.removeChild(trs[j])
    }
    trs = trs.slice(0, tableAST.rows.length)
  }

  for (let i = 0; i < tableAST.rows.length; i++) {
    const row = tableAST.rows[i]
    if (i === trs.length) {
      // We have to create a new TR
      const tr = document.createElement('tr')
      table.appendChild(tr)
      trs.push(tr)
      updateRow(tr, row, view)
    } else {
      // Transfer the contents
      updateRow(trs[i], row, view)
    }
  }
}

/**
 * This function takes a single table row to update it. This is basically the
 * second level of recursion for those tree structures, but since it is
 * noticeably different from the first level function above, and also the last
 * layer of recursion here, we use a second function for that.
 *
 * @param  {HTMLTableRowElement}  tr      The table row element
 * @param  {TableRow}             astRow  The AST table row element
 * @param  {EditorView}           view    The EditorView
 */
function updateRow (tr: HTMLTableRowElement, astRow: TableRow, view: EditorView): void {
  let tds = [...tr.querySelectorAll(astRow.isHeaderOrFooter ? 'th' : 'td')]
  if (tds.length > astRow.cells.length) {
    // Too many TDs --> Remove. The for-loop below accounts for too few.
    for (let j = astRow.cells.length; j < tds.length; j++) {
      tds[j].parentElement?.removeChild(tds[j])
    }
    tds = tds.slice(0, astRow.cells.length)
  }

  const mainSel = view.state.selection.main

  for (let i = 0; i < astRow.cells.length; i++) {
    const cell = astRow.cells[i]
    // NOTE: This only is true for a selection that is completely contained
    // within a cell. Any overlapping selection will not cause a rendering of
    // the editor view, because selections that cross table cell boundaries are
    // just ... puh.
    const selectionInCell =  mainSel.from >= cell.from && mainSel.to <= cell.to
    if (i === tds.length) {
      // We have to create a new TD
      const td = document.createElement(astRow.isHeaderOrFooter ? 'th' : 'td')
      // TODO: Enable citation rendering here
      td.innerHTML = nodeToHTML(cell.children, (citations, composite) => undefined, 0).trim()
      const handler = () => {
        console.log(`Click! Setting selection: ${cell.from}:${cell.to}`)
        // TODO: Find a more appropriate position for the cursor
        view.dispatch({ selection: { anchor: cell.from, head: cell.from } })
        td.removeEventListener('click', handler)
      }
      td.addEventListener('click', handler)
      tr.appendChild(td)
      tds.push(td)
    }

    // At this point, there is guaranteed to be an element at i. Now let's check
    // if there's a subview at this cell.
    const subview = EditorView.findFromDOM(tds[i])
    if (subview !== null && !selectionInCell) {
      console.log('Removing subview from table cell')
      // The selection was in the cell but isn't any longer -> remove the
      // subview.
      subview.destroy()
    } else if (subview === null && selectionInCell) {
      // Create a new subview to represent the selection here
      // Ensure the cell itself is empty before we mount the subview.
      console.log('Creating subview in table cell')
      tds[i].innerHTML = ''
      createSubviewForCell(view, tds[i], { from: cell.from, to: cell.to })
    } else if (subview === null) {
      // Simply transfer the contents
      // TODO: Enable citation rendering here
      tds[i].innerHTML = nodeToHTML(cell.children, (citations, composite) => undefined, 0).trim()
    } // Else: The cell has a subview and the selection is still in there.
  }
}

/**
 * Creates and mounts a sub-EditorView within the provided targetCell.
 *
 * @param  {EditorView}            mainView    The main view
 * @param  {HTMLTableCellElement}  targetCell  The cell element
 */
function createSubviewForCell (mainView: EditorView, targetCell: HTMLTableCellElement, cellRange: { from: number, to: number }): void {
  // TODO: Listen to main view updates and apply them as they come in.
  const state = EditorState.create({
    // Subviews always hold the entire document. This is to make synchronizing
    // updates between main and subviews faster and simpler. This should only
    // become a problem on very old computers for people working with 10MB
    // documents. This assumes that this would be an edge case.
    doc: mainView.state.sliceDoc(),
    extensions: [
      // A minimal set of extensions
      keymap.of(defaultKeymap),
      drawSelection(),
      syntaxHighlighting(defaultHighlightStyle),
      // A field whose sole purpose is to hide the two stretches of content
      // before and after the table cell contents
      StateField.define<DecorationSet>({
        create (state) {
          return Decoration.set([
            Decoration.replace({ block: true, inclusive: false })
              .range(0, cellRange.from), // Before
            Decoration.replace({ block: true, inclusive: false })
              .range(cellRange.to, mainView.state.doc.length) // After
          ])
        },
        update (value, tr) {
          // Ensure the range always stays the same
          return value.map(tr.changes)
        },
        provide: f => EditorView.decorations.from(f)
      })
    ]
  })

  const subview = new EditorView({
    state,
    parent: targetCell,
    // Route any updates to the main view
    dispatch: (tr, subview) => {
      // TODO: Find a way to update the subview as soon as the main view
      // gets updated.
      subview.update([tr])
      if (!tr.changes.empty && tr.annotation(syncAnnotation) === undefined) {
        const annotations: Annotation<any>[] = [syncAnnotation.of(true)]
        const userEvent = tr.annotation(Transaction.userEvent)
        if (userEvent !== undefined) {
          annotations.push(Transaction.userEvent.of(userEvent))
        }
        mainView.dispatch({ changes: tr.changes, annotations })
      }
    }
  })

  subview.focus()
}

// Define a StateField that handles the entire TableEditor Schischi, as well as
// a few helper extensions that are necessary for the functioning of the widgets
export const renderTables = [
  // The actual TableEditor provider
  StateField.define<DecorationSet>({
    create (state: EditorState) {
      return TableWidget.createForState(state)
    },
    update (field, tr) {
      // DEBUG We also need to recompute when the selection changed, check if we
      // could also explicitly check for the selection and update only when
      // necessary
      // return tr.docChanged ? TableWidget.createForState(tr.state) : field
      return TableWidget.createForState(tr.state)
    },
    provide: f => EditorView.decorations.from(f)
  }),
  // A theme for the various elements
  EditorView.baseTheme({
    '.cm-content .cm-table-editor-widget': {
      borderCollapse: 'collapse',
      margin: '0 2px 0 6px' // Taken from .cm-line so that tables align
    },
    '.cm-content .cm-table-editor-widget td, .cm-content .cm-table-editor-widget th': {
      border: '1px solid black',
      padding: '2px 4px'
    },
    '&dark .cm-content .cm-table-editor-widget td, &dark .cm-content .cm-table-editor-widget th': {
      borderColor: '#aaaaaa'
    }
  })
]
