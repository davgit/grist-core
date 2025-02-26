var _             = require('underscore');
var ko            = require('knockout');

var dom           = require('app/client/lib/dom');
var kd            = require('app/client/lib/koDom');
var koDomScrolly  = require('app/client/lib/koDomScrolly');
const {renderAllRows} = require('app/client/components/Printing');

require('app/client/lib/koUtil'); // Needed for subscribeInit.

var Base          = require('./Base');
var BaseView      = require('./BaseView');
var {CopySelection} = require('./CopySelection');
var RecordLayout  = require('./RecordLayout');
var commands      = require('./commands');
const {RowContextMenu} = require('../ui/RowContextMenu');

/**
 * DetailView component implements a list of record layouts.
 */
function DetailView(gristDoc, viewSectionModel) {
  BaseView.call(this, gristDoc, viewSectionModel, { 'addNewRow': true });

  this.viewFields = gristDoc.docModel.viewFields;
  this._isSingle = (this.viewSection.parentKey.peek() === 'single');

  //--------------------------------------------------
  // Create and attach the DOM for the view.
  this.recordLayout = this.autoDispose(RecordLayout.create({
    viewSection: this.viewSection,
    buildFieldDom: this.buildFieldDom.bind(this),
    buildContextMenu : this.buildContextMenu.bind(this),
    resizeCallback: () => {
      if (!this._isSingle) {
        this.scrolly().updateSize();
        // Keep the cursor in view if the scrolly height resets.
        // TODO: Ideally the original position should be kept in scroll view.
        this.scrolly().scrollRowIntoView(this.cursor.rowIndex.peek());
      }
    }
  }));

  this.scrolly = this.autoDispose(ko.computed(() => {
    if (!this.recordLayout.isEditingLayout() && !this._isSingle) {
      return koDomScrolly.getInstance(this.viewData);
    }
  }));

  // Reset scrolly heights when record theme changes, since it affects heights.
  this.autoDispose(this.viewSection.themeDef.subscribe(() => {
    var scrolly = this.scrolly();
    if (scrolly) {
      setTimeout(function() { scrolly.resetHeights(); }, 0);
    }
  }));

  this.layoutBoxIdx = ko.observable(0);

  //--------------------------------------------------
  if (this._isSingle) {
    this.detailRecord = this.autoDispose(this.tableModel.createFloatingRowModel());
    this._updateFloatingRow();
    this.autoDispose(this.cursor.rowIndex.subscribe(this._updateFloatingRow, this));
    this.autoDispose(this.viewData.subscribe(this._updateFloatingRow, this));
  } else {
    this.detailRecord = null;
  }

  //--------------------------------------------------
  // Construct DOM
  this.scrollPane = null;
  this.viewPane = this.autoDispose(this.buildDom());

  //--------------------------------------------------
  // Set up DOM event handling.

  // Clicking on a detail field selects that field.
  this.onEvent(this.viewPane, 'mousedown', '.g_record_detail_el', function(elem, event) {
    this.viewSection.hasFocus(true);
    var rowModel = this.recordLayout.getContainingRow(elem, this.viewPane);
    var field = this.recordLayout.getContainingField(elem, this.viewPane);
    commands.allCommands.setCursor.run(rowModel, field);
  });

  // Double-clicking on a field also starts editing the field.
  this.onEvent(this.viewPane, 'dblclick', '.g_record_detail_el', function(elem, event) {
    this.activateEditorAtCursor();
  });

  //--------------------------------------------------
  // Instantiate CommandGroups for the different modes.
  this.autoDispose(commands.createGroup(DetailView.generalCommands, this, this.viewSection.hasFocus));
  this.newFieldCommandGroup = this.autoDispose(
    commands.createGroup(DetailView.newFieldCommands, this, this.isNewFieldActive));
}
Base.setBaseFor(DetailView);
_.extend(DetailView.prototype, BaseView.prototype);


DetailView.prototype.onTableLoaded = function() {
  BaseView.prototype.onTableLoaded.call(this);
  this._updateFloatingRow();

  const scrolly = this.scrolly();
  if (scrolly) {
    scrolly.scrollToSavedPos(this.viewSection.lastScrollPos);
  }
};

DetailView.prototype._updateFloatingRow = function() {
  if (this.detailRecord) {
    this.viewData.setFloatingRowModel(this.detailRecord, this.cursor.rowIndex.peek());
  }
};

/**
 * DetailView commands.
 */
DetailView.generalCommands = {
  cursorUp: function() { this.cursor.fieldIndex(this.cursor.fieldIndex() - 1); },
  cursorDown: function() { this.cursor.fieldIndex(this.cursor.fieldIndex() + 1); },
  pageUp: function() { this.cursor.rowIndex(this.cursor.rowIndex() - 1); },
  pageDown: function() { this.cursor.rowIndex(this.cursor.rowIndex() + 1); },

  deleteRecords: function() {
    // Do not allow deleting the add record row.
    if (!this._isAddRow()) {
      this.deleteRow(this.cursor.rowIndex());
    }
  },

  copy: function() { return this.copy(this.getSelection()); },
  cut: function() { return this.cut(this.getSelection()); },
  paste: function(pasteObj, cutCallback) { return this.paste(pasteObj, cutCallback); },

  editLayout: function() {
    if (this.scrolly()) {
      this.scrolly().scrollRowIntoView(this.cursor.rowIndex());
    }
    this.recordLayout.editLayout(this.cursor.rowIndex());
  }
};

//----------------------------------------------------------------------

// TODO: Factor code duplicated with GridView for deleteRow, deleteColumn,
// insertDetailField out of the view modules

DetailView.prototype.deleteRow = function(index) {
  if (this.viewSection.disableAddRemoveRows()) {
    return;
  }
  var action = ['RemoveRecord', this.viewData.getRowId(index)];
  return this.tableModel.sendTableAction(action)
  .bind(this).then(function() {
    this.cursor.rowIndex(index);
  });
};

/**
 * Pastes the provided data at the current cursor.
 *
 * @param {Array} data - Array of arrays of data to be pasted. Each array represents a row.
 * i.e.  [["1-1", "1-2", "1-3"],
 *        ["2-1", "2-2", "2-3"]]
 * @param {Function} cutCallback - If provided returns the record removal action needed
 *  for a cut.
 */
DetailView.prototype.paste = function(data, cutCallback) {
  let pasteData = data[0][0];
  let field = this.viewSection.viewFields().at(this.cursor.fieldIndex());
  let isCompletePaste = (data.length === 1 && data[0].length === 1);

  let richData = this._parsePasteForView([[pasteData]], [field]);
  if (_.isEmpty(richData)) {
    return;
  }

  // Array containing the paste action to which the cut action will be added if it exists.
  const rowId = this.viewData.getRowId(this.cursor.rowIndex());
  const action = (rowId === 'new') ? ['BulkAddRecord', [null], richData] :
    ['BulkUpdateRecord', [rowId], richData];
  const cursorPos = this.cursor.getCursorPos();

  return this.sendPasteActions(isCompletePaste ? cutCallback : null,
    this.prepTableActions([action]))
    .then(results => {
      // If a row was added, get its rowId from the action results.
      const addRowId = (action[0] === 'BulkAddRecord' ? results[0][0] : null);
      // Restore the cursor to the right rowId, even if it jumped.
      this.cursor.setCursorPos({rowId: cursorPos.rowId === 'new' ? addRowId : cursorPos.rowId});
      this.copySelection(null);
    });
};

/**
 * Returns a selection of the selected rows and cols.  In the case of DetailView this will just
 * be one row and one column as multiple cell selection is not supported.
 *
 * @returns {Object} CopySelection
 */
DetailView.prototype.getSelection = function() {
  return new CopySelection(
    this.tableModel.tableData,
    [this.viewData.getRowId(this.cursor.rowIndex())],
    [this.viewSection.viewFields().at(this.cursor.fieldIndex())],
    {}
  );
};

DetailView.prototype.buildContextMenu = function(row, options) {
  const defaults = {
    disableInsert: Boolean(this.gristDoc.isReadonly.get() || this.viewSection.disableAddRemoveRows() || this.tableModel.tableMetaRow.onDemand()),
    disableDelete: Boolean(this.gristDoc.isReadonly.get() || this.viewSection.disableAddRemoveRows() || row._isAddRow()),
    isViewSorted: this.viewSection.activeSortSpec.peek().length > 0,
  };
  return RowContextMenu(options ? Object.assign(defaults, options) : defaults);
}

/**
 * Builds the DOM for the given field of the given row.
 * @param {MetaRowModel|String} field: Model for the field to render. For a new field being added,
 *    this may instead be an object with {isNewField:true, colRef, label, value}.
 * @param {DataRowModel} row: The record of data from which to render the given field.
 */
DetailView.prototype.buildFieldDom = function(field, row) {
  var self = this;
  if (field.isNewField) {
    return dom('div.g_record_detail_el.flexitem',
      kd.cssClass(function() { return 'detail_theme_field_' + self.viewSection.themeDef(); }),
      dom('div.g_record_detail_label', field.label),
      dom('div.g_record_detail_value', field.value)
    );
  }

  var isCellSelected = ko.pureComputed(function() {
    return this.cursor.fieldIndex() === (field && field._index()) &&
      this.cursor.rowIndex() === (row && row._index());
  }, this);
  var isCellActive = ko.pureComputed(function() {
    return this.viewSection.hasFocus() && isCellSelected();
  }, this);

  // Whether the cell is part of an active copy-paste operation.
  var isCopyActive = ko.computed(function() {
    return self.copySelection() &&
      self.copySelection().isCellSelected(row.getRowId(), field.colId());
  });

  this.autoDispose(isCellSelected.subscribe(yesNo => {
    if (yesNo) {
      var layoutBox = dom.findAncestor(fieldDom, '.layout_hbox');
      this.layoutBoxIdx(_.indexOf(layoutBox.parentElement.childNodes, layoutBox));
    }
  }));
  var fieldBuilder = this.fieldBuilders.at(field._index());
  var fieldDom = dom('div.g_record_detail_el.flexitem',
    dom.autoDispose(isCellSelected),
    dom.autoDispose(isCellActive),
    kd.cssClass(function() { return 'detail_theme_field_' + self.viewSection.themeDef(); }),
    dom('div.g_record_detail_label', kd.text(field.displayLabel)),
    dom('div.g_record_detail_value',
      kd.toggleClass('scissors', isCopyActive),
      kd.toggleClass('record-add', row._isAddRow),
      dom.autoDispose(isCopyActive),
      fieldBuilder.buildDomWithCursor(row, isCellActive, isCellSelected)
    )
  );
  return fieldDom;
};

DetailView.prototype.buildDom = function() {
  return dom('div.flexvbox.flexitem',
    // Add .detailview_single when showing a single card or while editing layout.
    kd.toggleClass('detailview_single',
      () => this._isSingle || this.recordLayout.isEditingLayout()),
    // Add a marker class that editor is active - used for hiding context menu toggle.
    kd.toggleClass('detailview_layout_editor', this.recordLayout.isEditingLayout),
    kd.maybe(this.recordLayout.isEditingLayout, () => {
      const rowId = this.viewData.getRowId(this.recordLayout.editIndex.peek());
      const record = this.getRenderedRowModel(rowId);
      return dom(
        this.recordLayout.buildLayoutDom(record, true),
        kd.cssClass(() => 'detail_theme_record_' + this.viewSection.themeDef()),
        kd.cssClass('detailview_record_' + this.viewSection.parentKey.peek()),
      );
    }),
    kd.maybe(() => !this.recordLayout.isEditingLayout(), () => {
      if (!this._isSingle) {
        return this.scrollPane = dom('div.detailview_scroll_pane.flexitem',
          kd.scrollChildIntoView(this.cursor.rowIndex),
          dom.onDispose(() => {
            // Save the previous scroll values to the section.
            if (this.scrolly()) {
              this.viewSection.lastScrollPos = this.scrolly().getScrollPos();
            }
          }),
          koDomScrolly.scrolly(this.viewData, {fitToWidth: true},
            row => this.makeRecord(row)),

          kd.maybe(this._isPrinting, () =>
            renderAllRows(this.tableModel, this.sortedRows.getKoArray().peek(), row =>
              this.makeRecord(row))
          ),
        );
      } else {
        return dom(
          this.makeRecord(this.detailRecord),
          kd.domData('itemModel', this.detailRecord),
          kd.hide(() => this.cursor.rowIndex() === null)
        );
      }
    }),
  );
};

/** @inheritdoc */
DetailView.prototype.buildTitleControls = function() {
  // Hide controls if this is a card list section, or if the section has a scroll cursor link, since
  // the controls can be confusing in this case.
  // Note that the controls should still be visible with a filter link.
  const showControls = ko.computed(() => {
    if (!this._isSingle || this.recordLayout.layoutEditor()) { return false; }
    const linkingState = this.viewSection.linkingState();
    return !(linkingState && Boolean(linkingState.cursorPos));
  });
  return dom('div',
    dom.autoDispose(showControls),

    kd.toggleClass('record-layout-editor', this.recordLayout.layoutEditor),
    kd.maybe(this.recordLayout.layoutEditor, (editor) => editor.buildEditorDom()),

    kd.maybe(showControls, () => dom('div.grist-single-record__menu.flexhbox.flexnone',
      dom('div.grist-single-record__menu__count.flexitem',
        // Total should not include the add record row
        kd.text(() => this._isAddRow() ? 'Add record' :
          `${this.cursor.rowIndex() + 1} of ${this.getLastDataRowIndex() + 1}`)
      ),
      dom('div.btn-group.btn-group-xs',
        dom('div.btn.btn-default.detail-left',
          dom('span.glyphicon.glyphicon-chevron-left'),
          dom.on('click', () => { this.cursor.rowIndex(this.cursor.rowIndex() - 1); }),
          kd.toggleClass('disabled', () => this.cursor.rowIndex() === 0)
        ),
        dom('div.btn.btn-default.detail-right',
          dom('span.glyphicon.glyphicon-chevron-right'),
          dom.on('click', () => { this.cursor.rowIndex(this.cursor.rowIndex() + 1); }),
          kd.toggleClass('disabled', () => this.cursor.rowIndex() >= this.viewData.all().length - 1)
        )
      ),
      dom('div.btn-group.btn-group-xs.detail-add-grp',
        dom('div.btn.btn-default.detail-add-btn',
          dom('span.glyphicon.glyphicon-plus'),
          dom.on('click', () => {
            let addRowIndex = this.viewData.getRowIndex('new');
            this.cursor.rowIndex(addRowIndex);
          }),
          kd.toggleClass('disabled', () => this.viewData.getRowId(this.cursor.rowIndex()) === 'new')
        )
      )
    ))
  );
};


/** @inheritdoc */
DetailView.prototype.onResize = function() {
  var scrolly = this.scrolly();
  if (scrolly) {
    scrolly.scheduleUpdateSize();
  }
};

/** @inheritdoc */
DetailView.prototype.onRowResize = function(rowModels) {
  var scrolly = this.scrolly();
  if (scrolly) {
    scrolly.resetItemHeights(rowModels);
  }
};

DetailView.prototype.makeRecord = function(record) {
  return dom(
    this.recordLayout.buildLayoutDom(record),
    kd.cssClass(() => 'detail_theme_record_' + this.viewSection.themeDef()),
    this.comparison ? kd.cssClass(() => {
      const rowType = this.extraRows.getRowType(record.id());
      return rowType && `diff-${rowType}` || '';
    }) : null,
    kd.toggleClass('active', () => (this.cursor.rowIndex() === record._index() && this.viewSection.hasFocus())),
    // 'detailview_record_single' or 'detailview_record_detail' doesn't need to be an observable,
    // since a change to parentKey would cause a separate call to makeRecord.
    kd.cssClass('detailview_record_' + this.viewSection.parentKey.peek())
  );
};

/**
 * Extends BaseView getRenderedRowModel. Called to obtain the rowModel for the given rowId.
 * Returns the rowModel if it is rendered in the current view type, otherwise returns null.
 */
DetailView.prototype.getRenderedRowModel = function(rowId) {
  if (this.detailRecord) {
    return this.detailRecord.getRowId() === rowId ? this.detailRecord : null;
  } else {
    return this.viewData.getRowModel(rowId);
  }
};

/**
 * Returns a boolean indicating whether the given index is the index of the add row.
 * Index defaults to the current index of the cursor.
 */
DetailView.prototype._isAddRow = function(index = this.cursor.rowIndex()) {
  return this.viewData.getRowId(index) === 'new';
};

DetailView.prototype.scrollToCursor = function(sync = true) {
  if (!this.scrollPane) { return Promise.resolve(); }
  return kd.doScrollChildIntoView(this.scrollPane, this.cursor.rowIndex(), sync);
}

module.exports = DetailView;
