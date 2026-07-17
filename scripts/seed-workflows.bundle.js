// scripts/seed-workflows.ts
import crypto4 from "node:crypto";
import fs2 from "node:fs";
import path from "node:path";

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/entity.js
var entityKind = /* @__PURE__ */ Symbol.for("drizzle:entityKind");
function is(value, type) {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (value instanceof type) {
    return true;
  }
  if (!Object.prototype.hasOwnProperty.call(type, entityKind)) {
    throw new Error(
      `Class "${type.name ?? "<unknown>"}" doesn't look like a Drizzle entity. If this is incorrect and the class is provided by Drizzle, please report this as a bug.`
    );
  }
  let cls = Object.getPrototypeOf(value).constructor;
  if (cls) {
    while (cls) {
      if (entityKind in cls && cls[entityKind] === type[entityKind]) {
        return true;
      }
      cls = Object.getPrototypeOf(cls);
    }
  }
  return false;
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/column.js
var Column = class {
  constructor(table, config) {
    this.table = table;
    this.config = config;
    this.name = config.name;
    this.keyAsName = config.keyAsName;
    this.notNull = config.notNull;
    this.default = config.default;
    this.defaultFn = config.defaultFn;
    this.onUpdateFn = config.onUpdateFn;
    this.hasDefault = config.hasDefault;
    this.primary = config.primaryKey;
    this.isUnique = config.isUnique;
    this.uniqueName = config.uniqueName;
    this.uniqueType = config.uniqueType;
    this.dataType = config.dataType;
    this.columnType = config.columnType;
    this.generated = config.generated;
    this.generatedIdentity = config.generatedIdentity;
  }
  static [entityKind] = "Column";
  name;
  keyAsName;
  primary;
  notNull;
  default;
  defaultFn;
  onUpdateFn;
  hasDefault;
  isUnique;
  uniqueName;
  uniqueType;
  dataType;
  columnType;
  enumValues = void 0;
  generated = void 0;
  generatedIdentity = void 0;
  config;
  mapFromDriverValue(value) {
    return value;
  }
  mapToDriverValue(value) {
    return value;
  }
  // ** @internal */
  shouldDisableInsert() {
    return this.config.generated !== void 0 && this.config.generated.type !== "byDefault";
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/column-builder.js
var ColumnBuilder = class {
  static [entityKind] = "ColumnBuilder";
  config;
  constructor(name, dataType, columnType) {
    this.config = {
      name,
      keyAsName: name === "",
      notNull: false,
      default: void 0,
      hasDefault: false,
      primaryKey: false,
      isUnique: false,
      uniqueName: void 0,
      uniqueType: void 0,
      dataType,
      columnType,
      generated: void 0
    };
  }
  /**
   * Changes the data type of the column. Commonly used with `json` columns. Also, useful for branded types.
   *
   * @example
   * ```ts
   * const users = pgTable('users', {
   * 	id: integer('id').$type<UserId>().primaryKey(),
   * 	details: json('details').$type<UserDetails>().notNull(),
   * });
   * ```
   */
  $type() {
    return this;
  }
  /**
   * Adds a `not null` clause to the column definition.
   *
   * Affects the `select` model of the table - columns *without* `not null` will be nullable on select.
   */
  notNull() {
    this.config.notNull = true;
    return this;
  }
  /**
   * Adds a `default <value>` clause to the column definition.
   *
   * Affects the `insert` model of the table - columns *with* `default` are optional on insert.
   *
   * If you need to set a dynamic default value, use {@link $defaultFn} instead.
   */
  default(value) {
    this.config.default = value;
    this.config.hasDefault = true;
    return this;
  }
  /**
   * Adds a dynamic default value to the column.
   * The function will be called when the row is inserted, and the returned value will be used as the column value.
   *
   * **Note:** This value does not affect the `drizzle-kit` behavior, it is only used at runtime in `drizzle-orm`.
   */
  $defaultFn(fn) {
    this.config.defaultFn = fn;
    this.config.hasDefault = true;
    return this;
  }
  /**
   * Alias for {@link $defaultFn}.
   */
  $default = this.$defaultFn;
  /**
   * Adds a dynamic update value to the column.
   * The function will be called when the row is updated, and the returned value will be used as the column value if none is provided.
   * If no `default` (or `$defaultFn`) value is provided, the function will be called when the row is inserted as well, and the returned value will be used as the column value.
   *
   * **Note:** This value does not affect the `drizzle-kit` behavior, it is only used at runtime in `drizzle-orm`.
   */
  $onUpdateFn(fn) {
    this.config.onUpdateFn = fn;
    this.config.hasDefault = true;
    return this;
  }
  /**
   * Alias for {@link $onUpdateFn}.
   */
  $onUpdate = this.$onUpdateFn;
  /**
   * Adds a `primary key` clause to the column definition. This implicitly makes the column `not null`.
   *
   * In SQLite, `integer primary key` implicitly makes the column auto-incrementing.
   */
  primaryKey() {
    this.config.primaryKey = true;
    this.config.notNull = true;
    return this;
  }
  /** @internal Sets the name of the column to the key within the table definition if a name was not given. */
  setName(name) {
    if (this.config.name !== "") return;
    this.config.name = name;
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/table.utils.js
var TableName = /* @__PURE__ */ Symbol.for("drizzle:Name");

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/foreign-keys.js
var ForeignKeyBuilder = class {
  static [entityKind] = "PgForeignKeyBuilder";
  /** @internal */
  reference;
  /** @internal */
  _onUpdate = "no action";
  /** @internal */
  _onDelete = "no action";
  constructor(config, actions) {
    this.reference = () => {
      const { name, columns, foreignColumns } = config();
      return { name, columns, foreignTable: foreignColumns[0].table, foreignColumns };
    };
    if (actions) {
      this._onUpdate = actions.onUpdate;
      this._onDelete = actions.onDelete;
    }
  }
  onUpdate(action) {
    this._onUpdate = action === void 0 ? "no action" : action;
    return this;
  }
  onDelete(action) {
    this._onDelete = action === void 0 ? "no action" : action;
    return this;
  }
  /** @internal */
  build(table) {
    return new ForeignKey(table, this);
  }
};
var ForeignKey = class {
  constructor(table, builder) {
    this.table = table;
    this.reference = builder.reference;
    this.onUpdate = builder._onUpdate;
    this.onDelete = builder._onDelete;
  }
  static [entityKind] = "PgForeignKey";
  reference;
  onUpdate;
  onDelete;
  getName() {
    const { name, columns, foreignColumns } = this.reference();
    const columnNames = columns.map((column) => column.name);
    const foreignColumnNames = foreignColumns.map((column) => column.name);
    const chunks = [
      this.table[TableName],
      ...columnNames,
      foreignColumns[0].table[TableName],
      ...foreignColumnNames
    ];
    return name ?? `${chunks.join("_")}_fk`;
  }
};
function foreignKey(config) {
  function mappedConfig() {
    const { name, columns, foreignColumns } = config;
    return {
      name,
      columns,
      foreignColumns
    };
  }
  return new ForeignKeyBuilder(mappedConfig);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/tracing-utils.js
function iife(fn, ...args) {
  return fn(...args);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/unique-constraint.js
function unique(name) {
  return new UniqueOnConstraintBuilder(name);
}
function uniqueKeyName(table, columns) {
  return `${table[TableName]}_${columns.join("_")}_unique`;
}
var UniqueConstraintBuilder = class {
  constructor(columns, name) {
    this.name = name;
    this.columns = columns;
  }
  static [entityKind] = "PgUniqueConstraintBuilder";
  /** @internal */
  columns;
  /** @internal */
  nullsNotDistinctConfig = false;
  nullsNotDistinct() {
    this.nullsNotDistinctConfig = true;
    return this;
  }
  /** @internal */
  build(table) {
    return new UniqueConstraint(table, this.columns, this.nullsNotDistinctConfig, this.name);
  }
};
var UniqueOnConstraintBuilder = class {
  static [entityKind] = "PgUniqueOnConstraintBuilder";
  /** @internal */
  name;
  constructor(name) {
    this.name = name;
  }
  on(...columns) {
    return new UniqueConstraintBuilder(columns, this.name);
  }
};
var UniqueConstraint = class {
  constructor(table, columns, nullsNotDistinct, name) {
    this.table = table;
    this.columns = columns;
    this.name = name ?? uniqueKeyName(this.table, this.columns.map((column) => column.name));
    this.nullsNotDistinct = nullsNotDistinct;
  }
  static [entityKind] = "PgUniqueConstraint";
  columns;
  name;
  nullsNotDistinct = false;
  getName() {
    return this.name;
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/utils/array.js
function parsePgArrayValue(arrayString, startFrom, inQuotes) {
  for (let i = startFrom; i < arrayString.length; i++) {
    const char2 = arrayString[i];
    if (char2 === "\\") {
      i++;
      continue;
    }
    if (char2 === '"') {
      return [arrayString.slice(startFrom, i).replace(/\\/g, ""), i + 1];
    }
    if (inQuotes) {
      continue;
    }
    if (char2 === "," || char2 === "}") {
      return [arrayString.slice(startFrom, i).replace(/\\/g, ""), i];
    }
  }
  return [arrayString.slice(startFrom).replace(/\\/g, ""), arrayString.length];
}
function parsePgNestedArray(arrayString, startFrom = 0) {
  const result = [];
  let i = startFrom;
  let lastCharIsComma = false;
  while (i < arrayString.length) {
    const char2 = arrayString[i];
    if (char2 === ",") {
      if (lastCharIsComma || i === startFrom) {
        result.push("");
      }
      lastCharIsComma = true;
      i++;
      continue;
    }
    lastCharIsComma = false;
    if (char2 === "\\") {
      i += 2;
      continue;
    }
    if (char2 === '"') {
      const [value2, startFrom2] = parsePgArrayValue(arrayString, i + 1, true);
      result.push(value2);
      i = startFrom2;
      continue;
    }
    if (char2 === "}") {
      return [result, i + 1];
    }
    if (char2 === "{") {
      const [value2, startFrom2] = parsePgNestedArray(arrayString, i + 1);
      result.push(value2);
      i = startFrom2;
      continue;
    }
    const [value, newStartFrom] = parsePgArrayValue(arrayString, i, false);
    result.push(value);
    i = newStartFrom;
  }
  return [result, i];
}
function parsePgArray(arrayString) {
  const [result] = parsePgNestedArray(arrayString, 1);
  return result;
}
function makePgArray(array) {
  return `{${array.map((item) => {
    if (Array.isArray(item)) {
      return makePgArray(item);
    }
    if (typeof item === "string") {
      return `"${item.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return `${item}`;
  }).join(",")}}`;
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/common.js
var PgColumnBuilder = class extends ColumnBuilder {
  foreignKeyConfigs = [];
  static [entityKind] = "PgColumnBuilder";
  array(size2) {
    return new PgArrayBuilder(this.config.name, this, size2);
  }
  references(ref, actions = {}) {
    this.foreignKeyConfigs.push({ ref, actions });
    return this;
  }
  unique(name, config) {
    this.config.isUnique = true;
    this.config.uniqueName = name;
    this.config.uniqueType = config?.nulls;
    return this;
  }
  generatedAlwaysAs(as) {
    this.config.generated = {
      as,
      type: "always",
      mode: "stored"
    };
    return this;
  }
  /** @internal */
  buildForeignKeys(column, table) {
    return this.foreignKeyConfigs.map(({ ref, actions }) => {
      return iife(
        (ref2, actions2) => {
          const builder = new ForeignKeyBuilder(() => {
            const foreignColumn = ref2();
            return { columns: [column], foreignColumns: [foreignColumn] };
          });
          if (actions2.onUpdate) {
            builder.onUpdate(actions2.onUpdate);
          }
          if (actions2.onDelete) {
            builder.onDelete(actions2.onDelete);
          }
          return builder.build(table);
        },
        ref,
        actions
      );
    });
  }
  /** @internal */
  buildExtraConfigColumn(table) {
    return new ExtraConfigColumn(table, this.config);
  }
};
var PgColumn = class extends Column {
  constructor(table, config) {
    if (!config.uniqueName) {
      config.uniqueName = uniqueKeyName(table, [config.name]);
    }
    super(table, config);
    this.table = table;
  }
  static [entityKind] = "PgColumn";
};
var ExtraConfigColumn = class extends PgColumn {
  static [entityKind] = "ExtraConfigColumn";
  getSQLType() {
    return this.getSQLType();
  }
  indexConfig = {
    order: this.config.order ?? "asc",
    nulls: this.config.nulls ?? "last",
    opClass: this.config.opClass
  };
  defaultConfig = {
    order: "asc",
    nulls: "last",
    opClass: void 0
  };
  asc() {
    this.indexConfig.order = "asc";
    return this;
  }
  desc() {
    this.indexConfig.order = "desc";
    return this;
  }
  nullsFirst() {
    this.indexConfig.nulls = "first";
    return this;
  }
  nullsLast() {
    this.indexConfig.nulls = "last";
    return this;
  }
  /**
   * ### PostgreSQL documentation quote
   *
   * > An operator class with optional parameters can be specified for each column of an index.
   * The operator class identifies the operators to be used by the index for that column.
   * For example, a B-tree index on four-byte integers would use the int4_ops class;
   * this operator class includes comparison functions for four-byte integers.
   * In practice the default operator class for the column's data type is usually sufficient.
   * The main point of having operator classes is that for some data types, there could be more than one meaningful ordering.
   * For example, we might want to sort a complex-number data type either by absolute value or by real part.
   * We could do this by defining two operator classes for the data type and then selecting the proper class when creating an index.
   * More information about operator classes check:
   *
   * ### Useful links
   * https://www.postgresql.org/docs/current/sql-createindex.html
   *
   * https://www.postgresql.org/docs/current/indexes-opclass.html
   *
   * https://www.postgresql.org/docs/current/xindex.html
   *
   * ### Additional types
   * If you have the `pg_vector` extension installed in your database, you can use the
   * `vector_l2_ops`, `vector_ip_ops`, `vector_cosine_ops`, `vector_l1_ops`, `bit_hamming_ops`, `bit_jaccard_ops`, `halfvec_l2_ops`, `sparsevec_l2_ops` options, which are predefined types.
   *
   * **You can always specify any string you want in the operator class, in case Drizzle doesn't have it natively in its types**
   *
   * @param opClass
   * @returns
   */
  op(opClass) {
    this.indexConfig.opClass = opClass;
    return this;
  }
};
var IndexedColumn = class {
  static [entityKind] = "IndexedColumn";
  constructor(name, keyAsName, type, indexConfig) {
    this.name = name;
    this.keyAsName = keyAsName;
    this.type = type;
    this.indexConfig = indexConfig;
  }
  name;
  keyAsName;
  type;
  indexConfig;
};
var PgArrayBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgArrayBuilder";
  constructor(name, baseBuilder, size2) {
    super(name, "array", "PgArray");
    this.config.baseBuilder = baseBuilder;
    this.config.size = size2;
  }
  /** @internal */
  build(table) {
    const baseColumn = this.config.baseBuilder.build(table);
    return new PgArray(
      table,
      this.config,
      baseColumn
    );
  }
};
var PgArray = class _PgArray extends PgColumn {
  constructor(table, config, baseColumn, range) {
    super(table, config);
    this.baseColumn = baseColumn;
    this.range = range;
    this.size = config.size;
  }
  size;
  static [entityKind] = "PgArray";
  getSQLType() {
    return `${this.baseColumn.getSQLType()}[${typeof this.size === "number" ? this.size : ""}]`;
  }
  mapFromDriverValue(value) {
    if (typeof value === "string") {
      value = parsePgArray(value);
    }
    return value.map((v) => this.baseColumn.mapFromDriverValue(v));
  }
  mapToDriverValue(value, isNestedArray = false) {
    const a = value.map(
      (v) => v === null ? null : is(this.baseColumn, _PgArray) ? this.baseColumn.mapToDriverValue(v, true) : this.baseColumn.mapToDriverValue(v)
    );
    if (isNestedArray) return a;
    return makePgArray(a);
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/enum.js
var PgEnumObjectColumnBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgEnumObjectColumnBuilder";
  constructor(name, enumInstance) {
    super(name, "string", "PgEnumObjectColumn");
    this.config.enum = enumInstance;
  }
  /** @internal */
  build(table) {
    return new PgEnumObjectColumn(
      table,
      this.config
    );
  }
};
var PgEnumObjectColumn = class extends PgColumn {
  static [entityKind] = "PgEnumObjectColumn";
  enum;
  enumValues = this.config.enum.enumValues;
  constructor(table, config) {
    super(table, config);
    this.enum = config.enum;
  }
  getSQLType() {
    return this.enum.enumName;
  }
};
var isPgEnumSym = /* @__PURE__ */ Symbol.for("drizzle:isPgEnum");
function isPgEnum(obj) {
  return !!obj && typeof obj === "function" && isPgEnumSym in obj && obj[isPgEnumSym] === true;
}
var PgEnumColumnBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgEnumColumnBuilder";
  constructor(name, enumInstance) {
    super(name, "string", "PgEnumColumn");
    this.config.enum = enumInstance;
  }
  /** @internal */
  build(table) {
    return new PgEnumColumn(
      table,
      this.config
    );
  }
};
var PgEnumColumn = class extends PgColumn {
  static [entityKind] = "PgEnumColumn";
  enum = this.config.enum;
  enumValues = this.config.enum.enumValues;
  constructor(table, config) {
    super(table, config);
    this.enum = config.enum;
  }
  getSQLType() {
    return this.enum.enumName;
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/subquery.js
var Subquery = class {
  static [entityKind] = "Subquery";
  constructor(sql2, fields, alias, isWith = false, usedTables = []) {
    this._ = {
      brand: "Subquery",
      sql: sql2,
      selectedFields: fields,
      alias,
      isWith,
      usedTables
    };
  }
  // getSQL(): SQL<unknown> {
  // 	return new SQL([this]);
  // }
};
var WithSubquery = class extends Subquery {
  static [entityKind] = "WithSubquery";
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/version.js
var version = "0.44.7";

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/tracing.js
var otel;
var rawTracer;
var tracer = {
  startActiveSpan(name, fn) {
    if (!otel) {
      return fn();
    }
    if (!rawTracer) {
      rawTracer = otel.trace.getTracer("drizzle-orm", version);
    }
    return iife(
      (otel2, rawTracer2) => rawTracer2.startActiveSpan(
        name,
        (span) => {
          try {
            return fn(span);
          } catch (e) {
            span.setStatus({
              code: otel2.SpanStatusCode.ERROR,
              message: e instanceof Error ? e.message : "Unknown error"
              // eslint-disable-line no-instanceof/no-instanceof
            });
            throw e;
          } finally {
            span.end();
          }
        }
      ),
      otel,
      rawTracer
    );
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/view-common.js
var ViewBaseConfig = /* @__PURE__ */ Symbol.for("drizzle:ViewBaseConfig");

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/table.js
var Schema = /* @__PURE__ */ Symbol.for("drizzle:Schema");
var Columns = /* @__PURE__ */ Symbol.for("drizzle:Columns");
var ExtraConfigColumns = /* @__PURE__ */ Symbol.for("drizzle:ExtraConfigColumns");
var OriginalName = /* @__PURE__ */ Symbol.for("drizzle:OriginalName");
var BaseName = /* @__PURE__ */ Symbol.for("drizzle:BaseName");
var IsAlias = /* @__PURE__ */ Symbol.for("drizzle:IsAlias");
var ExtraConfigBuilder = /* @__PURE__ */ Symbol.for("drizzle:ExtraConfigBuilder");
var IsDrizzleTable = /* @__PURE__ */ Symbol.for("drizzle:IsDrizzleTable");
var Table = class {
  static [entityKind] = "Table";
  /** @internal */
  static Symbol = {
    Name: TableName,
    Schema,
    OriginalName,
    Columns,
    ExtraConfigColumns,
    BaseName,
    IsAlias,
    ExtraConfigBuilder
  };
  /**
   * @internal
   * Can be changed if the table is aliased.
   */
  [TableName];
  /**
   * @internal
   * Used to store the original name of the table, before any aliasing.
   */
  [OriginalName];
  /** @internal */
  [Schema];
  /** @internal */
  [Columns];
  /** @internal */
  [ExtraConfigColumns];
  /**
   *  @internal
   * Used to store the table name before the transformation via the `tableCreator` functions.
   */
  [BaseName];
  /** @internal */
  [IsAlias] = false;
  /** @internal */
  [IsDrizzleTable] = true;
  /** @internal */
  [ExtraConfigBuilder] = void 0;
  constructor(name, schema, baseName) {
    this[TableName] = this[OriginalName] = name;
    this[Schema] = schema;
    this[BaseName] = baseName;
  }
};
function getTableName(table) {
  return table[TableName];
}
function getTableUniqueName(table) {
  return `${table[Schema] ?? "public"}.${table[TableName]}`;
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/sql/sql.js
var FakePrimitiveParam = class {
  static [entityKind] = "FakePrimitiveParam";
};
function isSQLWrapper(value) {
  return value !== null && value !== void 0 && typeof value.getSQL === "function";
}
function mergeQueries(queries) {
  const result = { sql: "", params: [] };
  for (const query of queries) {
    result.sql += query.sql;
    result.params.push(...query.params);
    if (query.typings?.length) {
      if (!result.typings) {
        result.typings = [];
      }
      result.typings.push(...query.typings);
    }
  }
  return result;
}
var StringChunk = class {
  static [entityKind] = "StringChunk";
  value;
  constructor(value) {
    this.value = Array.isArray(value) ? value : [value];
  }
  getSQL() {
    return new SQL([this]);
  }
};
var SQL = class _SQL {
  constructor(queryChunks) {
    this.queryChunks = queryChunks;
    for (const chunk of queryChunks) {
      if (is(chunk, Table)) {
        const schemaName = chunk[Table.Symbol.Schema];
        this.usedTables.push(
          schemaName === void 0 ? chunk[Table.Symbol.Name] : schemaName + "." + chunk[Table.Symbol.Name]
        );
      }
    }
  }
  static [entityKind] = "SQL";
  /** @internal */
  decoder = noopDecoder;
  shouldInlineParams = false;
  /** @internal */
  usedTables = [];
  append(query) {
    this.queryChunks.push(...query.queryChunks);
    return this;
  }
  toQuery(config) {
    return tracer.startActiveSpan("drizzle.buildSQL", (span) => {
      const query = this.buildQueryFromSourceParams(this.queryChunks, config);
      span?.setAttributes({
        "drizzle.query.text": query.sql,
        "drizzle.query.params": JSON.stringify(query.params)
      });
      return query;
    });
  }
  buildQueryFromSourceParams(chunks, _config) {
    const config = Object.assign({}, _config, {
      inlineParams: _config.inlineParams || this.shouldInlineParams,
      paramStartIndex: _config.paramStartIndex || { value: 0 }
    });
    const {
      casing,
      escapeName,
      escapeParam,
      prepareTyping,
      inlineParams,
      paramStartIndex
    } = config;
    return mergeQueries(chunks.map((chunk) => {
      if (is(chunk, StringChunk)) {
        return { sql: chunk.value.join(""), params: [] };
      }
      if (is(chunk, Name)) {
        return { sql: escapeName(chunk.value), params: [] };
      }
      if (chunk === void 0) {
        return { sql: "", params: [] };
      }
      if (Array.isArray(chunk)) {
        const result = [new StringChunk("(")];
        for (const [i, p] of chunk.entries()) {
          result.push(p);
          if (i < chunk.length - 1) {
            result.push(new StringChunk(", "));
          }
        }
        result.push(new StringChunk(")"));
        return this.buildQueryFromSourceParams(result, config);
      }
      if (is(chunk, _SQL)) {
        return this.buildQueryFromSourceParams(chunk.queryChunks, {
          ...config,
          inlineParams: inlineParams || chunk.shouldInlineParams
        });
      }
      if (is(chunk, Table)) {
        const schemaName = chunk[Table.Symbol.Schema];
        const tableName = chunk[Table.Symbol.Name];
        return {
          sql: schemaName === void 0 || chunk[IsAlias] ? escapeName(tableName) : escapeName(schemaName) + "." + escapeName(tableName),
          params: []
        };
      }
      if (is(chunk, Column)) {
        const columnName = casing.getColumnCasing(chunk);
        if (_config.invokeSource === "indexes") {
          return { sql: escapeName(columnName), params: [] };
        }
        const schemaName = chunk.table[Table.Symbol.Schema];
        return {
          sql: chunk.table[IsAlias] || schemaName === void 0 ? escapeName(chunk.table[Table.Symbol.Name]) + "." + escapeName(columnName) : escapeName(schemaName) + "." + escapeName(chunk.table[Table.Symbol.Name]) + "." + escapeName(columnName),
          params: []
        };
      }
      if (is(chunk, View)) {
        const schemaName = chunk[ViewBaseConfig].schema;
        const viewName = chunk[ViewBaseConfig].name;
        return {
          sql: schemaName === void 0 || chunk[ViewBaseConfig].isAlias ? escapeName(viewName) : escapeName(schemaName) + "." + escapeName(viewName),
          params: []
        };
      }
      if (is(chunk, Param)) {
        if (is(chunk.value, Placeholder)) {
          return { sql: escapeParam(paramStartIndex.value++, chunk), params: [chunk], typings: ["none"] };
        }
        const mappedValue = chunk.value === null ? null : chunk.encoder.mapToDriverValue(chunk.value);
        if (is(mappedValue, _SQL)) {
          return this.buildQueryFromSourceParams([mappedValue], config);
        }
        if (inlineParams) {
          return { sql: this.mapInlineParam(mappedValue, config), params: [] };
        }
        let typings = ["none"];
        if (prepareTyping) {
          typings = [prepareTyping(chunk.encoder)];
        }
        return { sql: escapeParam(paramStartIndex.value++, mappedValue), params: [mappedValue], typings };
      }
      if (is(chunk, Placeholder)) {
        return { sql: escapeParam(paramStartIndex.value++, chunk), params: [chunk], typings: ["none"] };
      }
      if (is(chunk, _SQL.Aliased) && chunk.fieldAlias !== void 0) {
        return { sql: escapeName(chunk.fieldAlias), params: [] };
      }
      if (is(chunk, Subquery)) {
        if (chunk._.isWith) {
          return { sql: escapeName(chunk._.alias), params: [] };
        }
        return this.buildQueryFromSourceParams([
          new StringChunk("("),
          chunk._.sql,
          new StringChunk(") "),
          new Name(chunk._.alias)
        ], config);
      }
      if (isPgEnum(chunk)) {
        if (chunk.schema) {
          return { sql: escapeName(chunk.schema) + "." + escapeName(chunk.enumName), params: [] };
        }
        return { sql: escapeName(chunk.enumName), params: [] };
      }
      if (isSQLWrapper(chunk)) {
        if (chunk.shouldOmitSQLParens?.()) {
          return this.buildQueryFromSourceParams([chunk.getSQL()], config);
        }
        return this.buildQueryFromSourceParams([
          new StringChunk("("),
          chunk.getSQL(),
          new StringChunk(")")
        ], config);
      }
      if (inlineParams) {
        return { sql: this.mapInlineParam(chunk, config), params: [] };
      }
      return { sql: escapeParam(paramStartIndex.value++, chunk), params: [chunk], typings: ["none"] };
    }));
  }
  mapInlineParam(chunk, { escapeString }) {
    if (chunk === null) {
      return "null";
    }
    if (typeof chunk === "number" || typeof chunk === "boolean") {
      return chunk.toString();
    }
    if (typeof chunk === "string") {
      return escapeString(chunk);
    }
    if (typeof chunk === "object") {
      const mappedValueAsString = chunk.toString();
      if (mappedValueAsString === "[object Object]") {
        return escapeString(JSON.stringify(chunk));
      }
      return escapeString(mappedValueAsString);
    }
    throw new Error("Unexpected param value: " + chunk);
  }
  getSQL() {
    return this;
  }
  as(alias) {
    if (alias === void 0) {
      return this;
    }
    return new _SQL.Aliased(this, alias);
  }
  mapWith(decoder) {
    this.decoder = typeof decoder === "function" ? { mapFromDriverValue: decoder } : decoder;
    return this;
  }
  inlineParams() {
    this.shouldInlineParams = true;
    return this;
  }
  /**
   * This method is used to conditionally include a part of the query.
   *
   * @param condition - Condition to check
   * @returns itself if the condition is `true`, otherwise `undefined`
   */
  if(condition) {
    return condition ? this : void 0;
  }
};
var Name = class {
  constructor(value) {
    this.value = value;
  }
  static [entityKind] = "Name";
  brand;
  getSQL() {
    return new SQL([this]);
  }
};
function isDriverValueEncoder(value) {
  return typeof value === "object" && value !== null && "mapToDriverValue" in value && typeof value.mapToDriverValue === "function";
}
var noopDecoder = {
  mapFromDriverValue: (value) => value
};
var noopEncoder = {
  mapToDriverValue: (value) => value
};
var noopMapper = {
  ...noopDecoder,
  ...noopEncoder
};
var Param = class {
  /**
   * @param value - Parameter value
   * @param encoder - Encoder to convert the value to a driver parameter
   */
  constructor(value, encoder = noopEncoder) {
    this.value = value;
    this.encoder = encoder;
  }
  static [entityKind] = "Param";
  brand;
  getSQL() {
    return new SQL([this]);
  }
};
function sql(strings, ...params) {
  const queryChunks = [];
  if (params.length > 0 || strings.length > 0 && strings[0] !== "") {
    queryChunks.push(new StringChunk(strings[0]));
  }
  for (const [paramIndex, param2] of params.entries()) {
    queryChunks.push(param2, new StringChunk(strings[paramIndex + 1]));
  }
  return new SQL(queryChunks);
}
((sql2) => {
  function empty() {
    return new SQL([]);
  }
  sql2.empty = empty;
  function fromList(list) {
    return new SQL(list);
  }
  sql2.fromList = fromList;
  function raw(str) {
    return new SQL([new StringChunk(str)]);
  }
  sql2.raw = raw;
  function join(chunks, separator) {
    const result = [];
    for (const [i, chunk] of chunks.entries()) {
      if (i > 0 && separator !== void 0) {
        result.push(separator);
      }
      result.push(chunk);
    }
    return new SQL(result);
  }
  sql2.join = join;
  function identifier(value) {
    return new Name(value);
  }
  sql2.identifier = identifier;
  function placeholder2(name2) {
    return new Placeholder(name2);
  }
  sql2.placeholder = placeholder2;
  function param2(value, encoder) {
    return new Param(value, encoder);
  }
  sql2.param = param2;
})(sql || (sql = {}));
((SQL2) => {
  class Aliased {
    constructor(sql2, fieldAlias) {
      this.sql = sql2;
      this.fieldAlias = fieldAlias;
    }
    static [entityKind] = "SQL.Aliased";
    /** @internal */
    isSelectionField = false;
    getSQL() {
      return this.sql;
    }
    /** @internal */
    clone() {
      return new Aliased(this.sql, this.fieldAlias);
    }
  }
  SQL2.Aliased = Aliased;
})(SQL || (SQL = {}));
var Placeholder = class {
  constructor(name2) {
    this.name = name2;
  }
  static [entityKind] = "Placeholder";
  getSQL() {
    return new SQL([this]);
  }
};
function fillPlaceholders(params, values2) {
  return params.map((p) => {
    if (is(p, Placeholder)) {
      if (!(p.name in values2)) {
        throw new Error(`No value for placeholder "${p.name}" was provided`);
      }
      return values2[p.name];
    }
    if (is(p, Param) && is(p.value, Placeholder)) {
      if (!(p.value.name in values2)) {
        throw new Error(`No value for placeholder "${p.value.name}" was provided`);
      }
      return p.encoder.mapToDriverValue(values2[p.value.name]);
    }
    return p;
  });
}
var IsDrizzleView = /* @__PURE__ */ Symbol.for("drizzle:IsDrizzleView");
var View = class {
  static [entityKind] = "View";
  /** @internal */
  [ViewBaseConfig];
  /** @internal */
  [IsDrizzleView] = true;
  constructor({ name: name2, schema, selectedFields, query }) {
    this[ViewBaseConfig] = {
      name: name2,
      originalName: name2,
      schema,
      selectedFields,
      query,
      isExisting: !query,
      isAlias: false
    };
  }
  getSQL() {
    return new SQL([this]);
  }
};
Column.prototype.getSQL = function() {
  return new SQL([this]);
};
Table.prototype.getSQL = function() {
  return new SQL([this]);
};
Subquery.prototype.getSQL = function() {
  return new SQL([this]);
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/alias.js
var ColumnAliasProxyHandler = class {
  constructor(table) {
    this.table = table;
  }
  static [entityKind] = "ColumnAliasProxyHandler";
  get(columnObj, prop) {
    if (prop === "table") {
      return this.table;
    }
    return columnObj[prop];
  }
};
var TableAliasProxyHandler = class {
  constructor(alias, replaceOriginalName) {
    this.alias = alias;
    this.replaceOriginalName = replaceOriginalName;
  }
  static [entityKind] = "TableAliasProxyHandler";
  get(target, prop) {
    if (prop === Table.Symbol.IsAlias) {
      return true;
    }
    if (prop === Table.Symbol.Name) {
      return this.alias;
    }
    if (this.replaceOriginalName && prop === Table.Symbol.OriginalName) {
      return this.alias;
    }
    if (prop === ViewBaseConfig) {
      return {
        ...target[ViewBaseConfig],
        name: this.alias,
        isAlias: true
      };
    }
    if (prop === Table.Symbol.Columns) {
      const columns = target[Table.Symbol.Columns];
      if (!columns) {
        return columns;
      }
      const proxiedColumns = {};
      Object.keys(columns).map((key) => {
        proxiedColumns[key] = new Proxy(
          columns[key],
          new ColumnAliasProxyHandler(new Proxy(target, this))
        );
      });
      return proxiedColumns;
    }
    const value = target[prop];
    if (is(value, Column)) {
      return new Proxy(value, new ColumnAliasProxyHandler(new Proxy(target, this)));
    }
    return value;
  }
};
var RelationTableAliasProxyHandler = class {
  constructor(alias) {
    this.alias = alias;
  }
  static [entityKind] = "RelationTableAliasProxyHandler";
  get(target, prop) {
    if (prop === "sourceTable") {
      return aliasedTable(target.sourceTable, this.alias);
    }
    return target[prop];
  }
};
function aliasedTable(table, tableAlias) {
  return new Proxy(table, new TableAliasProxyHandler(tableAlias, false));
}
function aliasedTableColumn(column, tableAlias) {
  return new Proxy(
    column,
    new ColumnAliasProxyHandler(new Proxy(column.table, new TableAliasProxyHandler(tableAlias, false)))
  );
}
function mapColumnsInAliasedSQLToAlias(query, alias) {
  return new SQL.Aliased(mapColumnsInSQLToAlias(query.sql, alias), query.fieldAlias);
}
function mapColumnsInSQLToAlias(query, alias) {
  return sql.join(query.queryChunks.map((c) => {
    if (is(c, Column)) {
      return aliasedTableColumn(c, alias);
    }
    if (is(c, SQL)) {
      return mapColumnsInSQLToAlias(c, alias);
    }
    if (is(c, SQL.Aliased)) {
      return mapColumnsInAliasedSQLToAlias(c, alias);
    }
    return c;
  }));
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/errors.js
var DrizzleError = class extends Error {
  static [entityKind] = "DrizzleError";
  constructor({ message, cause }) {
    super(message);
    this.name = "DrizzleError";
    this.cause = cause;
  }
};
var DrizzleQueryError = class _DrizzleQueryError extends Error {
  constructor(query, params, cause) {
    super(`Failed query: ${query}
params: ${params}`);
    this.query = query;
    this.params = params;
    this.cause = cause;
    Error.captureStackTrace(this, _DrizzleQueryError);
    if (cause) this.cause = cause;
  }
};
var TransactionRollbackError = class extends DrizzleError {
  static [entityKind] = "TransactionRollbackError";
  constructor() {
    super({ message: "Rollback" });
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/logger.js
var ConsoleLogWriter = class {
  static [entityKind] = "ConsoleLogWriter";
  write(message) {
    console.log(message);
  }
};
var DefaultLogger = class {
  static [entityKind] = "DefaultLogger";
  writer;
  constructor(config) {
    this.writer = config?.writer ?? new ConsoleLogWriter();
  }
  logQuery(query, params) {
    const stringifiedParams = params.map((p) => {
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    });
    const paramsStr = stringifiedParams.length ? ` -- params: [${stringifiedParams.join(", ")}]` : "";
    this.writer.write(`Query: ${query}${paramsStr}`);
  }
};
var NoopLogger = class {
  static [entityKind] = "NoopLogger";
  logQuery() {
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/query-promise.js
var QueryPromise = class {
  static [entityKind] = "QueryPromise";
  [Symbol.toStringTag] = "QueryPromise";
  catch(onRejected) {
    return this.then(void 0, onRejected);
  }
  finally(onFinally) {
    return this.then(
      (value) => {
        onFinally?.();
        return value;
      },
      (reason) => {
        onFinally?.();
        throw reason;
      }
    );
  }
  then(onFulfilled, onRejected) {
    return this.execute().then(onFulfilled, onRejected);
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/utils.js
function mapResultRow(columns, row, joinsNotNullableMap) {
  const nullifyMap = {};
  const result = columns.reduce(
    (result2, { path: path2, field }, columnIndex) => {
      let decoder;
      if (is(field, Column)) {
        decoder = field;
      } else if (is(field, SQL)) {
        decoder = field.decoder;
      } else {
        decoder = field.sql.decoder;
      }
      let node = result2;
      for (const [pathChunkIndex, pathChunk] of path2.entries()) {
        if (pathChunkIndex < path2.length - 1) {
          if (!(pathChunk in node)) {
            node[pathChunk] = {};
          }
          node = node[pathChunk];
        } else {
          const rawValue = row[columnIndex];
          const value = node[pathChunk] = rawValue === null ? null : decoder.mapFromDriverValue(rawValue);
          if (joinsNotNullableMap && is(field, Column) && path2.length === 2) {
            const objectName = path2[0];
            if (!(objectName in nullifyMap)) {
              nullifyMap[objectName] = value === null ? getTableName(field.table) : false;
            } else if (typeof nullifyMap[objectName] === "string" && nullifyMap[objectName] !== getTableName(field.table)) {
              nullifyMap[objectName] = false;
            }
          }
        }
      }
      return result2;
    },
    {}
  );
  if (joinsNotNullableMap && Object.keys(nullifyMap).length > 0) {
    for (const [objectName, tableName] of Object.entries(nullifyMap)) {
      if (typeof tableName === "string" && !joinsNotNullableMap[tableName]) {
        result[objectName] = null;
      }
    }
  }
  return result;
}
function orderSelectedFields(fields, pathPrefix) {
  return Object.entries(fields).reduce((result, [name, field]) => {
    if (typeof name !== "string") {
      return result;
    }
    const newPath = pathPrefix ? [...pathPrefix, name] : [name];
    if (is(field, Column) || is(field, SQL) || is(field, SQL.Aliased)) {
      result.push({ path: newPath, field });
    } else if (is(field, Table)) {
      result.push(...orderSelectedFields(field[Table.Symbol.Columns], newPath));
    } else {
      result.push(...orderSelectedFields(field, newPath));
    }
    return result;
  }, []);
}
function haveSameKeys(left, right) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const [index2, key] of leftKeys.entries()) {
    if (key !== rightKeys[index2]) {
      return false;
    }
  }
  return true;
}
function mapUpdateSet(table, values2) {
  const entries = Object.entries(values2).filter(([, value]) => value !== void 0).map(([key, value]) => {
    if (is(value, SQL) || is(value, Column)) {
      return [key, value];
    } else {
      return [key, new Param(value, table[Table.Symbol.Columns][key])];
    }
  });
  if (entries.length === 0) {
    throw new Error("No values to set");
  }
  return Object.fromEntries(entries);
}
function applyMixins(baseClass, extendedClasses) {
  for (const extendedClass of extendedClasses) {
    for (const name of Object.getOwnPropertyNames(extendedClass.prototype)) {
      if (name === "constructor") continue;
      Object.defineProperty(
        baseClass.prototype,
        name,
        Object.getOwnPropertyDescriptor(extendedClass.prototype, name) || /* @__PURE__ */ Object.create(null)
      );
    }
  }
}
function getTableColumns(table) {
  return table[Table.Symbol.Columns];
}
function getTableLikeName(table) {
  return is(table, Subquery) ? table._.alias : is(table, View) ? table[ViewBaseConfig].name : is(table, SQL) ? void 0 : table[Table.Symbol.IsAlias] ? table[Table.Symbol.Name] : table[Table.Symbol.BaseName];
}
function getColumnNameAndConfig(a, b2) {
  return {
    name: typeof a === "string" && a.length > 0 ? a : "",
    config: typeof a === "object" ? a : b2
  };
}
function isConfig(data) {
  if (typeof data !== "object" || data === null) return false;
  if (data.constructor.name !== "Object") return false;
  if ("logger" in data) {
    const type = typeof data["logger"];
    if (type !== "boolean" && (type !== "object" || typeof data["logger"]["logQuery"] !== "function") && type !== "undefined") return false;
    return true;
  }
  if ("schema" in data) {
    const type = typeof data["schema"];
    if (type !== "object" && type !== "undefined") return false;
    return true;
  }
  if ("casing" in data) {
    const type = typeof data["casing"];
    if (type !== "string" && type !== "undefined") return false;
    return true;
  }
  if ("mode" in data) {
    if (data["mode"] !== "default" || data["mode"] !== "planetscale" || data["mode"] !== void 0) return false;
    return true;
  }
  if ("connection" in data) {
    const type = typeof data["connection"];
    if (type !== "string" && type !== "object" && type !== "undefined") return false;
    return true;
  }
  if ("client" in data) {
    const type = typeof data["client"];
    if (type !== "object" && type !== "function" && type !== "undefined") return false;
    return true;
  }
  if (Object.keys(data).length === 0) return true;
  return false;
}
var textDecoder = typeof TextDecoder === "undefined" ? null : new TextDecoder();

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/int.common.js
var PgIntColumnBaseBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgIntColumnBaseBuilder";
  generatedAlwaysAsIdentity(sequence) {
    if (sequence) {
      const { name, ...options } = sequence;
      this.config.generatedIdentity = {
        type: "always",
        sequenceName: name,
        sequenceOptions: options
      };
    } else {
      this.config.generatedIdentity = {
        type: "always"
      };
    }
    this.config.hasDefault = true;
    this.config.notNull = true;
    return this;
  }
  generatedByDefaultAsIdentity(sequence) {
    if (sequence) {
      const { name, ...options } = sequence;
      this.config.generatedIdentity = {
        type: "byDefault",
        sequenceName: name,
        sequenceOptions: options
      };
    } else {
      this.config.generatedIdentity = {
        type: "byDefault"
      };
    }
    this.config.hasDefault = true;
    this.config.notNull = true;
    return this;
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/bigint.js
var PgBigInt53Builder = class extends PgIntColumnBaseBuilder {
  static [entityKind] = "PgBigInt53Builder";
  constructor(name) {
    super(name, "number", "PgBigInt53");
  }
  /** @internal */
  build(table) {
    return new PgBigInt53(table, this.config);
  }
};
var PgBigInt53 = class extends PgColumn {
  static [entityKind] = "PgBigInt53";
  getSQLType() {
    return "bigint";
  }
  mapFromDriverValue(value) {
    if (typeof value === "number") {
      return value;
    }
    return Number(value);
  }
};
var PgBigInt64Builder = class extends PgIntColumnBaseBuilder {
  static [entityKind] = "PgBigInt64Builder";
  constructor(name) {
    super(name, "bigint", "PgBigInt64");
  }
  /** @internal */
  build(table) {
    return new PgBigInt64(
      table,
      this.config
    );
  }
};
var PgBigInt64 = class extends PgColumn {
  static [entityKind] = "PgBigInt64";
  getSQLType() {
    return "bigint";
  }
  // eslint-disable-next-line unicorn/prefer-native-coercion-functions
  mapFromDriverValue(value) {
    return BigInt(value);
  }
};
function bigint(a, b2) {
  const { name, config } = getColumnNameAndConfig(a, b2);
  if (config.mode === "number") {
    return new PgBigInt53Builder(name);
  }
  return new PgBigInt64Builder(name);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/bigserial.js
var PgBigSerial53Builder = class extends PgColumnBuilder {
  static [entityKind] = "PgBigSerial53Builder";
  constructor(name) {
    super(name, "number", "PgBigSerial53");
    this.config.hasDefault = true;
    this.config.notNull = true;
  }
  /** @internal */
  build(table) {
    return new PgBigSerial53(
      table,
      this.config
    );
  }
};
var PgBigSerial53 = class extends PgColumn {
  static [entityKind] = "PgBigSerial53";
  getSQLType() {
    return "bigserial";
  }
  mapFromDriverValue(value) {
    if (typeof value === "number") {
      return value;
    }
    return Number(value);
  }
};
var PgBigSerial64Builder = class extends PgColumnBuilder {
  static [entityKind] = "PgBigSerial64Builder";
  constructor(name) {
    super(name, "bigint", "PgBigSerial64");
    this.config.hasDefault = true;
  }
  /** @internal */
  build(table) {
    return new PgBigSerial64(
      table,
      this.config
    );
  }
};
var PgBigSerial64 = class extends PgColumn {
  static [entityKind] = "PgBigSerial64";
  getSQLType() {
    return "bigserial";
  }
  // eslint-disable-next-line unicorn/prefer-native-coercion-functions
  mapFromDriverValue(value) {
    return BigInt(value);
  }
};
function bigserial(a, b2) {
  const { name, config } = getColumnNameAndConfig(a, b2);
  if (config.mode === "number") {
    return new PgBigSerial53Builder(name);
  }
  return new PgBigSerial64Builder(name);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/boolean.js
var PgBooleanBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgBooleanBuilder";
  constructor(name) {
    super(name, "boolean", "PgBoolean");
  }
  /** @internal */
  build(table) {
    return new PgBoolean(table, this.config);
  }
};
var PgBoolean = class extends PgColumn {
  static [entityKind] = "PgBoolean";
  getSQLType() {
    return "boolean";
  }
};
function boolean(name) {
  return new PgBooleanBuilder(name ?? "");
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/char.js
var PgCharBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgCharBuilder";
  constructor(name, config) {
    super(name, "string", "PgChar");
    this.config.length = config.length;
    this.config.enumValues = config.enum;
  }
  /** @internal */
  build(table) {
    return new PgChar(
      table,
      this.config
    );
  }
};
var PgChar = class extends PgColumn {
  static [entityKind] = "PgChar";
  length = this.config.length;
  enumValues = this.config.enumValues;
  getSQLType() {
    return this.length === void 0 ? `char` : `char(${this.length})`;
  }
};
function char(a, b2 = {}) {
  const { name, config } = getColumnNameAndConfig(a, b2);
  return new PgCharBuilder(name, config);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/cidr.js
var PgCidrBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgCidrBuilder";
  constructor(name) {
    super(name, "string", "PgCidr");
  }
  /** @internal */
  build(table) {
    return new PgCidr(table, this.config);
  }
};
var PgCidr = class extends PgColumn {
  static [entityKind] = "PgCidr";
  getSQLType() {
    return "cidr";
  }
};
function cidr(name) {
  return new PgCidrBuilder(name ?? "");
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/custom.js
var PgCustomColumnBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgCustomColumnBuilder";
  constructor(name, fieldConfig, customTypeParams) {
    super(name, "custom", "PgCustomColumn");
    this.config.fieldConfig = fieldConfig;
    this.config.customTypeParams = customTypeParams;
  }
  /** @internal */
  build(table) {
    return new PgCustomColumn(
      table,
      this.config
    );
  }
};
var PgCustomColumn = class extends PgColumn {
  static [entityKind] = "PgCustomColumn";
  sqlName;
  mapTo;
  mapFrom;
  constructor(table, config) {
    super(table, config);
    this.sqlName = config.customTypeParams.dataType(config.fieldConfig);
    this.mapTo = config.customTypeParams.toDriver;
    this.mapFrom = config.customTypeParams.fromDriver;
  }
  getSQLType() {
    return this.sqlName;
  }
  mapFromDriverValue(value) {
    return typeof this.mapFrom === "function" ? this.mapFrom(value) : value;
  }
  mapToDriverValue(value) {
    return typeof this.mapTo === "function" ? this.mapTo(value) : value;
  }
};
function customType(customTypeParams) {
  return (a, b2) => {
    const { name, config } = getColumnNameAndConfig(a, b2);
    return new PgCustomColumnBuilder(name, config, customTypeParams);
  };
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/date.common.js
var PgDateColumnBaseBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgDateColumnBaseBuilder";
  defaultNow() {
    return this.default(sql`now()`);
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/date.js
var PgDateBuilder = class extends PgDateColumnBaseBuilder {
  static [entityKind] = "PgDateBuilder";
  constructor(name) {
    super(name, "date", "PgDate");
  }
  /** @internal */
  build(table) {
    return new PgDate(table, this.config);
  }
};
var PgDate = class extends PgColumn {
  static [entityKind] = "PgDate";
  getSQLType() {
    return "date";
  }
  mapFromDriverValue(value) {
    return new Date(value);
  }
  mapToDriverValue(value) {
    return value.toISOString();
  }
};
var PgDateStringBuilder = class extends PgDateColumnBaseBuilder {
  static [entityKind] = "PgDateStringBuilder";
  constructor(name) {
    super(name, "string", "PgDateString");
  }
  /** @internal */
  build(table) {
    return new PgDateString(
      table,
      this.config
    );
  }
};
var PgDateString = class extends PgColumn {
  static [entityKind] = "PgDateString";
  getSQLType() {
    return "date";
  }
};
function date(a, b2) {
  const { name, config } = getColumnNameAndConfig(a, b2);
  if (config?.mode === "date") {
    return new PgDateBuilder(name);
  }
  return new PgDateStringBuilder(name);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/double-precision.js
var PgDoublePrecisionBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgDoublePrecisionBuilder";
  constructor(name) {
    super(name, "number", "PgDoublePrecision");
  }
  /** @internal */
  build(table) {
    return new PgDoublePrecision(
      table,
      this.config
    );
  }
};
var PgDoublePrecision = class extends PgColumn {
  static [entityKind] = "PgDoublePrecision";
  getSQLType() {
    return "double precision";
  }
  mapFromDriverValue(value) {
    if (typeof value === "string") {
      return Number.parseFloat(value);
    }
    return value;
  }
};
function doublePrecision(name) {
  return new PgDoublePrecisionBuilder(name ?? "");
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/inet.js
var PgInetBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgInetBuilder";
  constructor(name) {
    super(name, "string", "PgInet");
  }
  /** @internal */
  build(table) {
    return new PgInet(table, this.config);
  }
};
var PgInet = class extends PgColumn {
  static [entityKind] = "PgInet";
  getSQLType() {
    return "inet";
  }
};
function inet(name) {
  return new PgInetBuilder(name ?? "");
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/integer.js
var PgIntegerBuilder = class extends PgIntColumnBaseBuilder {
  static [entityKind] = "PgIntegerBuilder";
  constructor(name) {
    super(name, "number", "PgInteger");
  }
  /** @internal */
  build(table) {
    return new PgInteger(table, this.config);
  }
};
var PgInteger = class extends PgColumn {
  static [entityKind] = "PgInteger";
  getSQLType() {
    return "integer";
  }
  mapFromDriverValue(value) {
    if (typeof value === "string") {
      return Number.parseInt(value);
    }
    return value;
  }
};
function integer(name) {
  return new PgIntegerBuilder(name ?? "");
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/interval.js
var PgIntervalBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgIntervalBuilder";
  constructor(name, intervalConfig) {
    super(name, "string", "PgInterval");
    this.config.intervalConfig = intervalConfig;
  }
  /** @internal */
  build(table) {
    return new PgInterval(table, this.config);
  }
};
var PgInterval = class extends PgColumn {
  static [entityKind] = "PgInterval";
  fields = this.config.intervalConfig.fields;
  precision = this.config.intervalConfig.precision;
  getSQLType() {
    const fields = this.fields ? ` ${this.fields}` : "";
    const precision = this.precision ? `(${this.precision})` : "";
    return `interval${fields}${precision}`;
  }
};
function interval(a, b2 = {}) {
  const { name, config } = getColumnNameAndConfig(a, b2);
  return new PgIntervalBuilder(name, config);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/json.js
var PgJsonBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgJsonBuilder";
  constructor(name) {
    super(name, "json", "PgJson");
  }
  /** @internal */
  build(table) {
    return new PgJson(table, this.config);
  }
};
var PgJson = class extends PgColumn {
  static [entityKind] = "PgJson";
  constructor(table, config) {
    super(table, config);
  }
  getSQLType() {
    return "json";
  }
  mapToDriverValue(value) {
    return JSON.stringify(value);
  }
  mapFromDriverValue(value) {
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }
};
function json(name) {
  return new PgJsonBuilder(name ?? "");
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/jsonb.js
var PgJsonbBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgJsonbBuilder";
  constructor(name) {
    super(name, "json", "PgJsonb");
  }
  /** @internal */
  build(table) {
    return new PgJsonb(table, this.config);
  }
};
var PgJsonb = class extends PgColumn {
  static [entityKind] = "PgJsonb";
  constructor(table, config) {
    super(table, config);
  }
  getSQLType() {
    return "jsonb";
  }
  mapToDriverValue(value) {
    return JSON.stringify(value);
  }
  mapFromDriverValue(value) {
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }
};
function jsonb(name) {
  return new PgJsonbBuilder(name ?? "");
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/line.js
var PgLineBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgLineBuilder";
  constructor(name) {
    super(name, "array", "PgLine");
  }
  /** @internal */
  build(table) {
    return new PgLineTuple(
      table,
      this.config
    );
  }
};
var PgLineTuple = class extends PgColumn {
  static [entityKind] = "PgLine";
  getSQLType() {
    return "line";
  }
  mapFromDriverValue(value) {
    const [a, b2, c] = value.slice(1, -1).split(",");
    return [Number.parseFloat(a), Number.parseFloat(b2), Number.parseFloat(c)];
  }
  mapToDriverValue(value) {
    return `{${value[0]},${value[1]},${value[2]}}`;
  }
};
var PgLineABCBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgLineABCBuilder";
  constructor(name) {
    super(name, "json", "PgLineABC");
  }
  /** @internal */
  build(table) {
    return new PgLineABC(
      table,
      this.config
    );
  }
};
var PgLineABC = class extends PgColumn {
  static [entityKind] = "PgLineABC";
  getSQLType() {
    return "line";
  }
  mapFromDriverValue(value) {
    const [a, b2, c] = value.slice(1, -1).split(",");
    return { a: Number.parseFloat(a), b: Number.parseFloat(b2), c: Number.parseFloat(c) };
  }
  mapToDriverValue(value) {
    return `{${value.a},${value.b},${value.c}}`;
  }
};
function line(a, b2) {
  const { name, config } = getColumnNameAndConfig(a, b2);
  if (!config?.mode || config.mode === "tuple") {
    return new PgLineBuilder(name);
  }
  return new PgLineABCBuilder(name);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/macaddr.js
var PgMacaddrBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgMacaddrBuilder";
  constructor(name) {
    super(name, "string", "PgMacaddr");
  }
  /** @internal */
  build(table) {
    return new PgMacaddr(table, this.config);
  }
};
var PgMacaddr = class extends PgColumn {
  static [entityKind] = "PgMacaddr";
  getSQLType() {
    return "macaddr";
  }
};
function macaddr(name) {
  return new PgMacaddrBuilder(name ?? "");
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/macaddr8.js
var PgMacaddr8Builder = class extends PgColumnBuilder {
  static [entityKind] = "PgMacaddr8Builder";
  constructor(name) {
    super(name, "string", "PgMacaddr8");
  }
  /** @internal */
  build(table) {
    return new PgMacaddr8(table, this.config);
  }
};
var PgMacaddr8 = class extends PgColumn {
  static [entityKind] = "PgMacaddr8";
  getSQLType() {
    return "macaddr8";
  }
};
function macaddr8(name) {
  return new PgMacaddr8Builder(name ?? "");
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/numeric.js
var PgNumericBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgNumericBuilder";
  constructor(name, precision, scale) {
    super(name, "string", "PgNumeric");
    this.config.precision = precision;
    this.config.scale = scale;
  }
  /** @internal */
  build(table) {
    return new PgNumeric(table, this.config);
  }
};
var PgNumeric = class extends PgColumn {
  static [entityKind] = "PgNumeric";
  precision;
  scale;
  constructor(table, config) {
    super(table, config);
    this.precision = config.precision;
    this.scale = config.scale;
  }
  mapFromDriverValue(value) {
    if (typeof value === "string") return value;
    return String(value);
  }
  getSQLType() {
    if (this.precision !== void 0 && this.scale !== void 0) {
      return `numeric(${this.precision}, ${this.scale})`;
    } else if (this.precision === void 0) {
      return "numeric";
    } else {
      return `numeric(${this.precision})`;
    }
  }
};
var PgNumericNumberBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgNumericNumberBuilder";
  constructor(name, precision, scale) {
    super(name, "number", "PgNumericNumber");
    this.config.precision = precision;
    this.config.scale = scale;
  }
  /** @internal */
  build(table) {
    return new PgNumericNumber(
      table,
      this.config
    );
  }
};
var PgNumericNumber = class extends PgColumn {
  static [entityKind] = "PgNumericNumber";
  precision;
  scale;
  constructor(table, config) {
    super(table, config);
    this.precision = config.precision;
    this.scale = config.scale;
  }
  mapFromDriverValue(value) {
    if (typeof value === "number") return value;
    return Number(value);
  }
  mapToDriverValue = String;
  getSQLType() {
    if (this.precision !== void 0 && this.scale !== void 0) {
      return `numeric(${this.precision}, ${this.scale})`;
    } else if (this.precision === void 0) {
      return "numeric";
    } else {
      return `numeric(${this.precision})`;
    }
  }
};
var PgNumericBigIntBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgNumericBigIntBuilder";
  constructor(name, precision, scale) {
    super(name, "bigint", "PgNumericBigInt");
    this.config.precision = precision;
    this.config.scale = scale;
  }
  /** @internal */
  build(table) {
    return new PgNumericBigInt(
      table,
      this.config
    );
  }
};
var PgNumericBigInt = class extends PgColumn {
  static [entityKind] = "PgNumericBigInt";
  precision;
  scale;
  constructor(table, config) {
    super(table, config);
    this.precision = config.precision;
    this.scale = config.scale;
  }
  mapFromDriverValue = BigInt;
  mapToDriverValue = String;
  getSQLType() {
    if (this.precision !== void 0 && this.scale !== void 0) {
      return `numeric(${this.precision}, ${this.scale})`;
    } else if (this.precision === void 0) {
      return "numeric";
    } else {
      return `numeric(${this.precision})`;
    }
  }
};
function numeric(a, b2) {
  const { name, config } = getColumnNameAndConfig(a, b2);
  const mode = config?.mode;
  return mode === "number" ? new PgNumericNumberBuilder(name, config?.precision, config?.scale) : mode === "bigint" ? new PgNumericBigIntBuilder(name, config?.precision, config?.scale) : new PgNumericBuilder(name, config?.precision, config?.scale);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/point.js
var PgPointTupleBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgPointTupleBuilder";
  constructor(name) {
    super(name, "array", "PgPointTuple");
  }
  /** @internal */
  build(table) {
    return new PgPointTuple(
      table,
      this.config
    );
  }
};
var PgPointTuple = class extends PgColumn {
  static [entityKind] = "PgPointTuple";
  getSQLType() {
    return "point";
  }
  mapFromDriverValue(value) {
    if (typeof value === "string") {
      const [x, y] = value.slice(1, -1).split(",");
      return [Number.parseFloat(x), Number.parseFloat(y)];
    }
    return [value.x, value.y];
  }
  mapToDriverValue(value) {
    return `(${value[0]},${value[1]})`;
  }
};
var PgPointObjectBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgPointObjectBuilder";
  constructor(name) {
    super(name, "json", "PgPointObject");
  }
  /** @internal */
  build(table) {
    return new PgPointObject(
      table,
      this.config
    );
  }
};
var PgPointObject = class extends PgColumn {
  static [entityKind] = "PgPointObject";
  getSQLType() {
    return "point";
  }
  mapFromDriverValue(value) {
    if (typeof value === "string") {
      const [x, y] = value.slice(1, -1).split(",");
      return { x: Number.parseFloat(x), y: Number.parseFloat(y) };
    }
    return value;
  }
  mapToDriverValue(value) {
    return `(${value.x},${value.y})`;
  }
};
function point(a, b2) {
  const { name, config } = getColumnNameAndConfig(a, b2);
  if (!config?.mode || config.mode === "tuple") {
    return new PgPointTupleBuilder(name);
  }
  return new PgPointObjectBuilder(name);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/postgis_extension/utils.js
function hexToBytes(hex) {
  const bytes = [];
  for (let c = 0; c < hex.length; c += 2) {
    bytes.push(Number.parseInt(hex.slice(c, c + 2), 16));
  }
  return new Uint8Array(bytes);
}
function bytesToFloat64(bytes, offset) {
  const buffer2 = new ArrayBuffer(8);
  const view = new DataView(buffer2);
  for (let i = 0; i < 8; i++) {
    view.setUint8(i, bytes[offset + i]);
  }
  return view.getFloat64(0, true);
}
function parseEWKB(hex) {
  const bytes = hexToBytes(hex);
  let offset = 0;
  const byteOrder = bytes[offset];
  offset += 1;
  const view = new DataView(bytes.buffer);
  const geomType = view.getUint32(offset, byteOrder === 1);
  offset += 4;
  let _srid;
  if (geomType & 536870912) {
    _srid = view.getUint32(offset, byteOrder === 1);
    offset += 4;
  }
  if ((geomType & 65535) === 1) {
    const x = bytesToFloat64(bytes, offset);
    offset += 8;
    const y = bytesToFloat64(bytes, offset);
    offset += 8;
    return [x, y];
  }
  throw new Error("Unsupported geometry type");
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/postgis_extension/geometry.js
var PgGeometryBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgGeometryBuilder";
  constructor(name) {
    super(name, "array", "PgGeometry");
  }
  /** @internal */
  build(table) {
    return new PgGeometry(
      table,
      this.config
    );
  }
};
var PgGeometry = class extends PgColumn {
  static [entityKind] = "PgGeometry";
  getSQLType() {
    return "geometry(point)";
  }
  mapFromDriverValue(value) {
    return parseEWKB(value);
  }
  mapToDriverValue(value) {
    return `point(${value[0]} ${value[1]})`;
  }
};
var PgGeometryObjectBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgGeometryObjectBuilder";
  constructor(name) {
    super(name, "json", "PgGeometryObject");
  }
  /** @internal */
  build(table) {
    return new PgGeometryObject(
      table,
      this.config
    );
  }
};
var PgGeometryObject = class extends PgColumn {
  static [entityKind] = "PgGeometryObject";
  getSQLType() {
    return "geometry(point)";
  }
  mapFromDriverValue(value) {
    const parsed = parseEWKB(value);
    return { x: parsed[0], y: parsed[1] };
  }
  mapToDriverValue(value) {
    return `point(${value.x} ${value.y})`;
  }
};
function geometry(a, b2) {
  const { name, config } = getColumnNameAndConfig(a, b2);
  if (!config?.mode || config.mode === "tuple") {
    return new PgGeometryBuilder(name);
  }
  return new PgGeometryObjectBuilder(name);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/real.js
var PgRealBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgRealBuilder";
  constructor(name, length) {
    super(name, "number", "PgReal");
    this.config.length = length;
  }
  /** @internal */
  build(table) {
    return new PgReal(table, this.config);
  }
};
var PgReal = class extends PgColumn {
  static [entityKind] = "PgReal";
  constructor(table, config) {
    super(table, config);
  }
  getSQLType() {
    return "real";
  }
  mapFromDriverValue = (value) => {
    if (typeof value === "string") {
      return Number.parseFloat(value);
    }
    return value;
  };
};
function real(name) {
  return new PgRealBuilder(name ?? "");
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/serial.js
var PgSerialBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgSerialBuilder";
  constructor(name) {
    super(name, "number", "PgSerial");
    this.config.hasDefault = true;
    this.config.notNull = true;
  }
  /** @internal */
  build(table) {
    return new PgSerial(table, this.config);
  }
};
var PgSerial = class extends PgColumn {
  static [entityKind] = "PgSerial";
  getSQLType() {
    return "serial";
  }
};
function serial(name) {
  return new PgSerialBuilder(name ?? "");
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/smallint.js
var PgSmallIntBuilder = class extends PgIntColumnBaseBuilder {
  static [entityKind] = "PgSmallIntBuilder";
  constructor(name) {
    super(name, "number", "PgSmallInt");
  }
  /** @internal */
  build(table) {
    return new PgSmallInt(table, this.config);
  }
};
var PgSmallInt = class extends PgColumn {
  static [entityKind] = "PgSmallInt";
  getSQLType() {
    return "smallint";
  }
  mapFromDriverValue = (value) => {
    if (typeof value === "string") {
      return Number(value);
    }
    return value;
  };
};
function smallint(name) {
  return new PgSmallIntBuilder(name ?? "");
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/smallserial.js
var PgSmallSerialBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgSmallSerialBuilder";
  constructor(name) {
    super(name, "number", "PgSmallSerial");
    this.config.hasDefault = true;
    this.config.notNull = true;
  }
  /** @internal */
  build(table) {
    return new PgSmallSerial(
      table,
      this.config
    );
  }
};
var PgSmallSerial = class extends PgColumn {
  static [entityKind] = "PgSmallSerial";
  getSQLType() {
    return "smallserial";
  }
};
function smallserial(name) {
  return new PgSmallSerialBuilder(name ?? "");
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/text.js
var PgTextBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgTextBuilder";
  constructor(name, config) {
    super(name, "string", "PgText");
    this.config.enumValues = config.enum;
  }
  /** @internal */
  build(table) {
    return new PgText(table, this.config);
  }
};
var PgText = class extends PgColumn {
  static [entityKind] = "PgText";
  enumValues = this.config.enumValues;
  getSQLType() {
    return "text";
  }
};
function text(a, b2 = {}) {
  const { name, config } = getColumnNameAndConfig(a, b2);
  return new PgTextBuilder(name, config);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/time.js
var PgTimeBuilder = class extends PgDateColumnBaseBuilder {
  constructor(name, withTimezone, precision) {
    super(name, "string", "PgTime");
    this.withTimezone = withTimezone;
    this.precision = precision;
    this.config.withTimezone = withTimezone;
    this.config.precision = precision;
  }
  static [entityKind] = "PgTimeBuilder";
  /** @internal */
  build(table) {
    return new PgTime(table, this.config);
  }
};
var PgTime = class extends PgColumn {
  static [entityKind] = "PgTime";
  withTimezone;
  precision;
  constructor(table, config) {
    super(table, config);
    this.withTimezone = config.withTimezone;
    this.precision = config.precision;
  }
  getSQLType() {
    const precision = this.precision === void 0 ? "" : `(${this.precision})`;
    return `time${precision}${this.withTimezone ? " with time zone" : ""}`;
  }
};
function time(a, b2 = {}) {
  const { name, config } = getColumnNameAndConfig(a, b2);
  return new PgTimeBuilder(name, config.withTimezone ?? false, config.precision);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/timestamp.js
var PgTimestampBuilder = class extends PgDateColumnBaseBuilder {
  static [entityKind] = "PgTimestampBuilder";
  constructor(name, withTimezone, precision) {
    super(name, "date", "PgTimestamp");
    this.config.withTimezone = withTimezone;
    this.config.precision = precision;
  }
  /** @internal */
  build(table) {
    return new PgTimestamp(table, this.config);
  }
};
var PgTimestamp = class extends PgColumn {
  static [entityKind] = "PgTimestamp";
  withTimezone;
  precision;
  constructor(table, config) {
    super(table, config);
    this.withTimezone = config.withTimezone;
    this.precision = config.precision;
  }
  getSQLType() {
    const precision = this.precision === void 0 ? "" : ` (${this.precision})`;
    return `timestamp${precision}${this.withTimezone ? " with time zone" : ""}`;
  }
  mapFromDriverValue = (value) => {
    return new Date(this.withTimezone ? value : value + "+0000");
  };
  mapToDriverValue = (value) => {
    return value.toISOString();
  };
};
var PgTimestampStringBuilder = class extends PgDateColumnBaseBuilder {
  static [entityKind] = "PgTimestampStringBuilder";
  constructor(name, withTimezone, precision) {
    super(name, "string", "PgTimestampString");
    this.config.withTimezone = withTimezone;
    this.config.precision = precision;
  }
  /** @internal */
  build(table) {
    return new PgTimestampString(
      table,
      this.config
    );
  }
};
var PgTimestampString = class extends PgColumn {
  static [entityKind] = "PgTimestampString";
  withTimezone;
  precision;
  constructor(table, config) {
    super(table, config);
    this.withTimezone = config.withTimezone;
    this.precision = config.precision;
  }
  getSQLType() {
    const precision = this.precision === void 0 ? "" : `(${this.precision})`;
    return `timestamp${precision}${this.withTimezone ? " with time zone" : ""}`;
  }
};
function timestamp(a, b2 = {}) {
  const { name, config } = getColumnNameAndConfig(a, b2);
  if (config?.mode === "string") {
    return new PgTimestampStringBuilder(name, config.withTimezone ?? false, config.precision);
  }
  return new PgTimestampBuilder(name, config?.withTimezone ?? false, config?.precision);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/uuid.js
var PgUUIDBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgUUIDBuilder";
  constructor(name) {
    super(name, "string", "PgUUID");
  }
  /**
   * Adds `default gen_random_uuid()` to the column definition.
   */
  defaultRandom() {
    return this.default(sql`gen_random_uuid()`);
  }
  /** @internal */
  build(table) {
    return new PgUUID(table, this.config);
  }
};
var PgUUID = class extends PgColumn {
  static [entityKind] = "PgUUID";
  getSQLType() {
    return "uuid";
  }
};
function uuid(name) {
  return new PgUUIDBuilder(name ?? "");
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/varchar.js
var PgVarcharBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgVarcharBuilder";
  constructor(name, config) {
    super(name, "string", "PgVarchar");
    this.config.length = config.length;
    this.config.enumValues = config.enum;
  }
  /** @internal */
  build(table) {
    return new PgVarchar(
      table,
      this.config
    );
  }
};
var PgVarchar = class extends PgColumn {
  static [entityKind] = "PgVarchar";
  length = this.config.length;
  enumValues = this.config.enumValues;
  getSQLType() {
    return this.length === void 0 ? `varchar` : `varchar(${this.length})`;
  }
};
function varchar(a, b2 = {}) {
  const { name, config } = getColumnNameAndConfig(a, b2);
  return new PgVarcharBuilder(name, config);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/vector_extension/bit.js
var PgBinaryVectorBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgBinaryVectorBuilder";
  constructor(name, config) {
    super(name, "string", "PgBinaryVector");
    this.config.dimensions = config.dimensions;
  }
  /** @internal */
  build(table) {
    return new PgBinaryVector(
      table,
      this.config
    );
  }
};
var PgBinaryVector = class extends PgColumn {
  static [entityKind] = "PgBinaryVector";
  dimensions = this.config.dimensions;
  getSQLType() {
    return `bit(${this.dimensions})`;
  }
};
function bit(a, b2) {
  const { name, config } = getColumnNameAndConfig(a, b2);
  return new PgBinaryVectorBuilder(name, config);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/vector_extension/halfvec.js
var PgHalfVectorBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgHalfVectorBuilder";
  constructor(name, config) {
    super(name, "array", "PgHalfVector");
    this.config.dimensions = config.dimensions;
  }
  /** @internal */
  build(table) {
    return new PgHalfVector(
      table,
      this.config
    );
  }
};
var PgHalfVector = class extends PgColumn {
  static [entityKind] = "PgHalfVector";
  dimensions = this.config.dimensions;
  getSQLType() {
    return `halfvec(${this.dimensions})`;
  }
  mapToDriverValue(value) {
    return JSON.stringify(value);
  }
  mapFromDriverValue(value) {
    return value.slice(1, -1).split(",").map((v) => Number.parseFloat(v));
  }
};
function halfvec(a, b2) {
  const { name, config } = getColumnNameAndConfig(a, b2);
  return new PgHalfVectorBuilder(name, config);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/vector_extension/sparsevec.js
var PgSparseVectorBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgSparseVectorBuilder";
  constructor(name, config) {
    super(name, "string", "PgSparseVector");
    this.config.dimensions = config.dimensions;
  }
  /** @internal */
  build(table) {
    return new PgSparseVector(
      table,
      this.config
    );
  }
};
var PgSparseVector = class extends PgColumn {
  static [entityKind] = "PgSparseVector";
  dimensions = this.config.dimensions;
  getSQLType() {
    return `sparsevec(${this.dimensions})`;
  }
};
function sparsevec(a, b2) {
  const { name, config } = getColumnNameAndConfig(a, b2);
  return new PgSparseVectorBuilder(name, config);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/vector_extension/vector.js
var PgVectorBuilder = class extends PgColumnBuilder {
  static [entityKind] = "PgVectorBuilder";
  constructor(name, config) {
    super(name, "array", "PgVector");
    this.config.dimensions = config.dimensions;
  }
  /** @internal */
  build(table) {
    return new PgVector(
      table,
      this.config
    );
  }
};
var PgVector = class extends PgColumn {
  static [entityKind] = "PgVector";
  dimensions = this.config.dimensions;
  getSQLType() {
    return `vector(${this.dimensions})`;
  }
  mapToDriverValue(value) {
    return JSON.stringify(value);
  }
  mapFromDriverValue(value) {
    return value.slice(1, -1).split(",").map((v) => Number.parseFloat(v));
  }
};
function vector(a, b2) {
  const { name, config } = getColumnNameAndConfig(a, b2);
  return new PgVectorBuilder(name, config);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/columns/all.js
function getPgColumnBuilders() {
  return {
    bigint,
    bigserial,
    boolean,
    char,
    cidr,
    customType,
    date,
    doublePrecision,
    inet,
    integer,
    interval,
    json,
    jsonb,
    line,
    macaddr,
    macaddr8,
    numeric,
    point,
    geometry,
    real,
    serial,
    smallint,
    smallserial,
    text,
    time,
    timestamp,
    uuid,
    varchar,
    bit,
    halfvec,
    sparsevec,
    vector
  };
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/table.js
var InlineForeignKeys = /* @__PURE__ */ Symbol.for("drizzle:PgInlineForeignKeys");
var EnableRLS = /* @__PURE__ */ Symbol.for("drizzle:EnableRLS");
var PgTable = class extends Table {
  static [entityKind] = "PgTable";
  /** @internal */
  static Symbol = Object.assign({}, Table.Symbol, {
    InlineForeignKeys,
    EnableRLS
  });
  /**@internal */
  [InlineForeignKeys] = [];
  /** @internal */
  [EnableRLS] = false;
  /** @internal */
  [Table.Symbol.ExtraConfigBuilder] = void 0;
  /** @internal */
  [Table.Symbol.ExtraConfigColumns] = {};
};
function pgTableWithSchema(name, columns, extraConfig, schema, baseName = name) {
  const rawTable = new PgTable(name, schema, baseName);
  const parsedColumns = typeof columns === "function" ? columns(getPgColumnBuilders()) : columns;
  const builtColumns = Object.fromEntries(
    Object.entries(parsedColumns).map(([name2, colBuilderBase]) => {
      const colBuilder = colBuilderBase;
      colBuilder.setName(name2);
      const column = colBuilder.build(rawTable);
      rawTable[InlineForeignKeys].push(...colBuilder.buildForeignKeys(column, rawTable));
      return [name2, column];
    })
  );
  const builtColumnsForExtraConfig = Object.fromEntries(
    Object.entries(parsedColumns).map(([name2, colBuilderBase]) => {
      const colBuilder = colBuilderBase;
      colBuilder.setName(name2);
      const column = colBuilder.buildExtraConfigColumn(rawTable);
      return [name2, column];
    })
  );
  const table = Object.assign(rawTable, builtColumns);
  table[Table.Symbol.Columns] = builtColumns;
  table[Table.Symbol.ExtraConfigColumns] = builtColumnsForExtraConfig;
  if (extraConfig) {
    table[PgTable.Symbol.ExtraConfigBuilder] = extraConfig;
  }
  return Object.assign(table, {
    enableRLS: () => {
      table[PgTable.Symbol.EnableRLS] = true;
      return table;
    }
  });
}
var pgTable = (name, columns, extraConfig) => {
  return pgTableWithSchema(name, columns, extraConfig, void 0);
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/primary-keys.js
function primaryKey(...config) {
  if (config[0].columns) {
    return new PrimaryKeyBuilder(config[0].columns, config[0].name);
  }
  return new PrimaryKeyBuilder(config);
}
var PrimaryKeyBuilder = class {
  static [entityKind] = "PgPrimaryKeyBuilder";
  /** @internal */
  columns;
  /** @internal */
  name;
  constructor(columns, name) {
    this.columns = columns;
    this.name = name;
  }
  /** @internal */
  build(table) {
    return new PrimaryKey(table, this.columns, this.name);
  }
};
var PrimaryKey = class {
  constructor(table, columns, name) {
    this.table = table;
    this.columns = columns;
    this.name = name;
  }
  static [entityKind] = "PgPrimaryKey";
  columns;
  name;
  getName() {
    return this.name ?? `${this.table[PgTable.Symbol.Name]}_${this.columns.map((column) => column.name).join("_")}_pk`;
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/sql/expressions/conditions.js
function bindIfParam(value, column) {
  if (isDriverValueEncoder(column) && !isSQLWrapper(value) && !is(value, Param) && !is(value, Placeholder) && !is(value, Column) && !is(value, Table) && !is(value, View)) {
    return new Param(value, column);
  }
  return value;
}
var eq = (left, right) => {
  return sql`${left} = ${bindIfParam(right, left)}`;
};
var ne = (left, right) => {
  return sql`${left} <> ${bindIfParam(right, left)}`;
};
function and(...unfilteredConditions) {
  const conditions = unfilteredConditions.filter(
    (c) => c !== void 0
  );
  if (conditions.length === 0) {
    return void 0;
  }
  if (conditions.length === 1) {
    return new SQL(conditions);
  }
  return new SQL([
    new StringChunk("("),
    sql.join(conditions, new StringChunk(" and ")),
    new StringChunk(")")
  ]);
}
function or(...unfilteredConditions) {
  const conditions = unfilteredConditions.filter(
    (c) => c !== void 0
  );
  if (conditions.length === 0) {
    return void 0;
  }
  if (conditions.length === 1) {
    return new SQL(conditions);
  }
  return new SQL([
    new StringChunk("("),
    sql.join(conditions, new StringChunk(" or ")),
    new StringChunk(")")
  ]);
}
function not(condition) {
  return sql`not ${condition}`;
}
var gt = (left, right) => {
  return sql`${left} > ${bindIfParam(right, left)}`;
};
var gte = (left, right) => {
  return sql`${left} >= ${bindIfParam(right, left)}`;
};
var lt = (left, right) => {
  return sql`${left} < ${bindIfParam(right, left)}`;
};
var lte = (left, right) => {
  return sql`${left} <= ${bindIfParam(right, left)}`;
};
function inArray(column, values2) {
  if (Array.isArray(values2)) {
    if (values2.length === 0) {
      return sql`false`;
    }
    return sql`${column} in ${values2.map((v) => bindIfParam(v, column))}`;
  }
  return sql`${column} in ${bindIfParam(values2, column)}`;
}
function notInArray(column, values2) {
  if (Array.isArray(values2)) {
    if (values2.length === 0) {
      return sql`true`;
    }
    return sql`${column} not in ${values2.map((v) => bindIfParam(v, column))}`;
  }
  return sql`${column} not in ${bindIfParam(values2, column)}`;
}
function isNull(value) {
  return sql`${value} is null`;
}
function isNotNull(value) {
  return sql`${value} is not null`;
}
function exists(subquery) {
  return sql`exists ${subquery}`;
}
function notExists(subquery) {
  return sql`not exists ${subquery}`;
}
function between(column, min, max) {
  return sql`${column} between ${bindIfParam(min, column)} and ${bindIfParam(
    max,
    column
  )}`;
}
function notBetween(column, min, max) {
  return sql`${column} not between ${bindIfParam(
    min,
    column
  )} and ${bindIfParam(max, column)}`;
}
function like(column, value) {
  return sql`${column} like ${value}`;
}
function notLike(column, value) {
  return sql`${column} not like ${value}`;
}
function ilike(column, value) {
  return sql`${column} ilike ${value}`;
}
function notIlike(column, value) {
  return sql`${column} not ilike ${value}`;
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/sql/expressions/select.js
function asc(column) {
  return sql`${column} asc`;
}
function desc(column) {
  return sql`${column} desc`;
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/relations.js
var Relation = class {
  constructor(sourceTable, referencedTable, relationName) {
    this.sourceTable = sourceTable;
    this.referencedTable = referencedTable;
    this.relationName = relationName;
    this.referencedTableName = referencedTable[Table.Symbol.Name];
  }
  static [entityKind] = "Relation";
  referencedTableName;
  fieldName;
};
var Relations = class {
  constructor(table, config) {
    this.table = table;
    this.config = config;
  }
  static [entityKind] = "Relations";
};
var One = class _One extends Relation {
  constructor(sourceTable, referencedTable, config, isNullable) {
    super(sourceTable, referencedTable, config?.relationName);
    this.config = config;
    this.isNullable = isNullable;
  }
  static [entityKind] = "One";
  withFieldName(fieldName) {
    const relation = new _One(
      this.sourceTable,
      this.referencedTable,
      this.config,
      this.isNullable
    );
    relation.fieldName = fieldName;
    return relation;
  }
};
var Many = class _Many extends Relation {
  constructor(sourceTable, referencedTable, config) {
    super(sourceTable, referencedTable, config?.relationName);
    this.config = config;
  }
  static [entityKind] = "Many";
  withFieldName(fieldName) {
    const relation = new _Many(
      this.sourceTable,
      this.referencedTable,
      this.config
    );
    relation.fieldName = fieldName;
    return relation;
  }
};
function getOperators() {
  return {
    and,
    between,
    eq,
    exists,
    gt,
    gte,
    ilike,
    inArray,
    isNull,
    isNotNull,
    like,
    lt,
    lte,
    ne,
    not,
    notBetween,
    notExists,
    notLike,
    notIlike,
    notInArray,
    or,
    sql
  };
}
function getOrderByOperators() {
  return {
    sql,
    asc,
    desc
  };
}
function extractTablesRelationalConfig(schema, configHelpers) {
  if (Object.keys(schema).length === 1 && "default" in schema && !is(schema["default"], Table)) {
    schema = schema["default"];
  }
  const tableNamesMap = {};
  const relationsBuffer = {};
  const tablesConfig = {};
  for (const [key, value] of Object.entries(schema)) {
    if (is(value, Table)) {
      const dbName = getTableUniqueName(value);
      const bufferedRelations = relationsBuffer[dbName];
      tableNamesMap[dbName] = key;
      tablesConfig[key] = {
        tsName: key,
        dbName: value[Table.Symbol.Name],
        schema: value[Table.Symbol.Schema],
        columns: value[Table.Symbol.Columns],
        relations: bufferedRelations?.relations ?? {},
        primaryKey: bufferedRelations?.primaryKey ?? []
      };
      for (const column of Object.values(
        value[Table.Symbol.Columns]
      )) {
        if (column.primary) {
          tablesConfig[key].primaryKey.push(column);
        }
      }
      const extraConfig = value[Table.Symbol.ExtraConfigBuilder]?.(value[Table.Symbol.ExtraConfigColumns]);
      if (extraConfig) {
        for (const configEntry of Object.values(extraConfig)) {
          if (is(configEntry, PrimaryKeyBuilder)) {
            tablesConfig[key].primaryKey.push(...configEntry.columns);
          }
        }
      }
    } else if (is(value, Relations)) {
      const dbName = getTableUniqueName(value.table);
      const tableName = tableNamesMap[dbName];
      const relations2 = value.config(
        configHelpers(value.table)
      );
      let primaryKey2;
      for (const [relationName, relation] of Object.entries(relations2)) {
        if (tableName) {
          const tableConfig = tablesConfig[tableName];
          tableConfig.relations[relationName] = relation;
          if (primaryKey2) {
            tableConfig.primaryKey.push(...primaryKey2);
          }
        } else {
          if (!(dbName in relationsBuffer)) {
            relationsBuffer[dbName] = {
              relations: {},
              primaryKey: primaryKey2
            };
          }
          relationsBuffer[dbName].relations[relationName] = relation;
        }
      }
    }
  }
  return { tables: tablesConfig, tableNamesMap };
}
function relations(table, relations2) {
  return new Relations(
    table,
    (helpers) => Object.fromEntries(
      Object.entries(relations2(helpers)).map(([key, value]) => [
        key,
        value.withFieldName(key)
      ])
    )
  );
}
function createOne(sourceTable) {
  return function one(table, config) {
    return new One(
      sourceTable,
      table,
      config,
      config?.fields.reduce((res, f) => res && f.notNull, true) ?? false
    );
  };
}
function createMany(sourceTable) {
  return function many(referencedTable, config) {
    return new Many(sourceTable, referencedTable, config);
  };
}
function normalizeRelation(schema, tableNamesMap, relation) {
  if (is(relation, One) && relation.config) {
    return {
      fields: relation.config.fields,
      references: relation.config.references
    };
  }
  const referencedTableTsName = tableNamesMap[getTableUniqueName(relation.referencedTable)];
  if (!referencedTableTsName) {
    throw new Error(
      `Table "${relation.referencedTable[Table.Symbol.Name]}" not found in schema`
    );
  }
  const referencedTableConfig = schema[referencedTableTsName];
  if (!referencedTableConfig) {
    throw new Error(`Table "${referencedTableTsName}" not found in schema`);
  }
  const sourceTable = relation.sourceTable;
  const sourceTableTsName = tableNamesMap[getTableUniqueName(sourceTable)];
  if (!sourceTableTsName) {
    throw new Error(
      `Table "${sourceTable[Table.Symbol.Name]}" not found in schema`
    );
  }
  const reverseRelations = [];
  for (const referencedTableRelation of Object.values(
    referencedTableConfig.relations
  )) {
    if (relation.relationName && relation !== referencedTableRelation && referencedTableRelation.relationName === relation.relationName || !relation.relationName && referencedTableRelation.referencedTable === relation.sourceTable) {
      reverseRelations.push(referencedTableRelation);
    }
  }
  if (reverseRelations.length > 1) {
    throw relation.relationName ? new Error(
      `There are multiple relations with name "${relation.relationName}" in table "${referencedTableTsName}"`
    ) : new Error(
      `There are multiple relations between "${referencedTableTsName}" and "${relation.sourceTable[Table.Symbol.Name]}". Please specify relation name`
    );
  }
  if (reverseRelations[0] && is(reverseRelations[0], One) && reverseRelations[0].config) {
    return {
      fields: reverseRelations[0].config.references,
      references: reverseRelations[0].config.fields
    };
  }
  throw new Error(
    `There is not enough information to infer relation "${sourceTableTsName}.${relation.fieldName}"`
  );
}
function createTableRelationsHelpers(sourceTable) {
  return {
    one: createOne(sourceTable),
    many: createMany(sourceTable)
  };
}
function mapRelationalRow(tablesConfig, tableConfig, row, buildQueryResultSelection, mapColumnValue = (value) => value) {
  const result = {};
  for (const [
    selectionItemIndex,
    selectionItem
  ] of buildQueryResultSelection.entries()) {
    if (selectionItem.isJson) {
      const relation = tableConfig.relations[selectionItem.tsKey];
      const rawSubRows = row[selectionItemIndex];
      const subRows = typeof rawSubRows === "string" ? JSON.parse(rawSubRows) : rawSubRows;
      result[selectionItem.tsKey] = is(relation, One) ? subRows && mapRelationalRow(
        tablesConfig,
        tablesConfig[selectionItem.relationTableTsKey],
        subRows,
        selectionItem.selection,
        mapColumnValue
      ) : subRows.map(
        (subRow) => mapRelationalRow(
          tablesConfig,
          tablesConfig[selectionItem.relationTableTsKey],
          subRow,
          selectionItem.selection,
          mapColumnValue
        )
      );
    } else {
      const value = mapColumnValue(row[selectionItemIndex]);
      const field = selectionItem.field;
      let decoder;
      if (is(field, Column)) {
        decoder = field;
      } else if (is(field, SQL)) {
        decoder = field.decoder;
      } else {
        decoder = field.sql.decoder;
      }
      result[selectionItem.tsKey] = value === null ? null : decoder.mapFromDriverValue(value);
    }
  }
  return result;
}

// node_modules/.pnpm/postgres@3.4.8/node_modules/postgres/src/index.js
import os from "os";
import fs from "fs";

// node_modules/.pnpm/postgres@3.4.8/node_modules/postgres/src/query.js
var originCache = /* @__PURE__ */ new Map();
var originStackCache = /* @__PURE__ */ new Map();
var originError = /* @__PURE__ */ Symbol("OriginError");
var CLOSE = {};
var Query = class extends Promise {
  constructor(strings, args, handler, canceller, options = {}) {
    let resolve, reject;
    super((a, b2) => {
      resolve = a;
      reject = b2;
    });
    this.tagged = Array.isArray(strings.raw);
    this.strings = strings;
    this.args = args;
    this.handler = handler;
    this.canceller = canceller;
    this.options = options;
    this.state = null;
    this.statement = null;
    this.resolve = (x) => (this.active = false, resolve(x));
    this.reject = (x) => (this.active = false, reject(x));
    this.active = false;
    this.cancelled = null;
    this.executed = false;
    this.signature = "";
    this[originError] = this.handler.debug ? new Error() : this.tagged && cachedError(this.strings);
  }
  get origin() {
    return (this.handler.debug ? this[originError].stack : this.tagged && originStackCache.has(this.strings) ? originStackCache.get(this.strings) : originStackCache.set(this.strings, this[originError].stack).get(this.strings)) || "";
  }
  static get [Symbol.species]() {
    return Promise;
  }
  cancel() {
    return this.canceller && (this.canceller(this), this.canceller = null);
  }
  simple() {
    this.options.simple = true;
    this.options.prepare = false;
    return this;
  }
  async readable() {
    this.simple();
    this.streaming = true;
    return this;
  }
  async writable() {
    this.simple();
    this.streaming = true;
    return this;
  }
  cursor(rows = 1, fn) {
    this.options.simple = false;
    if (typeof rows === "function") {
      fn = rows;
      rows = 1;
    }
    this.cursorRows = rows;
    if (typeof fn === "function")
      return this.cursorFn = fn, this;
    let prev;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (this.executed && !this.active)
            return { done: true };
          prev && prev();
          const promise = new Promise((resolve, reject) => {
            this.cursorFn = (value) => {
              resolve({ value, done: false });
              return new Promise((r) => prev = r);
            };
            this.resolve = () => (this.active = false, resolve({ done: true }));
            this.reject = (x) => (this.active = false, reject(x));
          });
          this.execute();
          return promise;
        },
        return() {
          prev && prev(CLOSE);
          return { done: true };
        }
      })
    };
  }
  describe() {
    this.options.simple = false;
    this.onlyDescribe = this.options.prepare = true;
    return this;
  }
  stream() {
    throw new Error(".stream has been renamed to .forEach");
  }
  forEach(fn) {
    this.forEachFn = fn;
    this.handle();
    return this;
  }
  raw() {
    this.isRaw = true;
    return this;
  }
  values() {
    this.isRaw = "values";
    return this;
  }
  async handle() {
    !this.executed && (this.executed = true) && await 1 && this.handler(this);
  }
  execute() {
    this.handle();
    return this;
  }
  then() {
    this.handle();
    return super.then.apply(this, arguments);
  }
  catch() {
    this.handle();
    return super.catch.apply(this, arguments);
  }
  finally() {
    this.handle();
    return super.finally.apply(this, arguments);
  }
};
function cachedError(xs) {
  if (originCache.has(xs))
    return originCache.get(xs);
  const x = Error.stackTraceLimit;
  Error.stackTraceLimit = 4;
  originCache.set(xs, new Error());
  Error.stackTraceLimit = x;
  return originCache.get(xs);
}

// node_modules/.pnpm/postgres@3.4.8/node_modules/postgres/src/errors.js
var PostgresError = class extends Error {
  constructor(x) {
    super(x.message);
    this.name = this.constructor.name;
    Object.assign(this, x);
  }
};
var Errors = {
  connection,
  postgres,
  generic,
  notSupported
};
function connection(x, options, socket) {
  const { host, port } = socket || options;
  const error = Object.assign(
    new Error("write " + x + " " + (options.path || host + ":" + port)),
    {
      code: x,
      errno: x,
      address: options.path || host
    },
    options.path ? {} : { port }
  );
  Error.captureStackTrace(error, connection);
  return error;
}
function postgres(x) {
  const error = new PostgresError(x);
  Error.captureStackTrace(error, postgres);
  return error;
}
function generic(code, message) {
  const error = Object.assign(new Error(code + ": " + message), { code });
  Error.captureStackTrace(error, generic);
  return error;
}
function notSupported(x) {
  const error = Object.assign(
    new Error(x + " (B) is not supported"),
    {
      code: "MESSAGE_NOT_SUPPORTED",
      name: x
    }
  );
  Error.captureStackTrace(error, notSupported);
  return error;
}

// node_modules/.pnpm/postgres@3.4.8/node_modules/postgres/src/types.js
var types = {
  string: {
    to: 25,
    from: null,
    // defaults to string
    serialize: (x) => "" + x
  },
  number: {
    to: 0,
    from: [21, 23, 26, 700, 701],
    serialize: (x) => "" + x,
    parse: (x) => +x
  },
  json: {
    to: 114,
    from: [114, 3802],
    serialize: (x) => JSON.stringify(x),
    parse: (x) => JSON.parse(x)
  },
  boolean: {
    to: 16,
    from: 16,
    serialize: (x) => x === true ? "t" : "f",
    parse: (x) => x === "t"
  },
  date: {
    to: 1184,
    from: [1082, 1114, 1184],
    serialize: (x) => (x instanceof Date ? x : new Date(x)).toISOString(),
    parse: (x) => new Date(x)
  },
  bytea: {
    to: 17,
    from: 17,
    serialize: (x) => "\\x" + Buffer.from(x).toString("hex"),
    parse: (x) => Buffer.from(x.slice(2), "hex")
  }
};
var NotTagged = class {
  then() {
    notTagged();
  }
  catch() {
    notTagged();
  }
  finally() {
    notTagged();
  }
};
var Identifier = class extends NotTagged {
  constructor(value) {
    super();
    this.value = escapeIdentifier(value);
  }
};
var Parameter = class extends NotTagged {
  constructor(value, type, array) {
    super();
    this.value = value;
    this.type = type;
    this.array = array;
  }
};
var Builder = class extends NotTagged {
  constructor(first, rest) {
    super();
    this.first = first;
    this.rest = rest;
  }
  build(before, parameters, types2, options) {
    const keyword = builders.map(([x, fn]) => ({ fn, i: before.search(x) })).sort((a, b2) => a.i - b2.i).pop();
    return keyword.i === -1 ? escapeIdentifiers(this.first, options) : keyword.fn(this.first, this.rest, parameters, types2, options);
  }
};
function handleValue(x, parameters, types2, options) {
  let value = x instanceof Parameter ? x.value : x;
  if (value === void 0) {
    x instanceof Parameter ? x.value = options.transform.undefined : value = x = options.transform.undefined;
    if (value === void 0)
      throw Errors.generic("UNDEFINED_VALUE", "Undefined values are not allowed");
  }
  return "$" + types2.push(
    x instanceof Parameter ? (parameters.push(x.value), x.array ? x.array[x.type || inferType(x.value)] || x.type || firstIsString(x.value) : x.type) : (parameters.push(x), inferType(x))
  );
}
var defaultHandlers = typeHandlers(types);
function stringify(q, string, value, parameters, types2, options) {
  for (let i = 1; i < q.strings.length; i++) {
    string += stringifyValue(string, value, parameters, types2, options) + q.strings[i];
    value = q.args[i];
  }
  return string;
}
function stringifyValue(string, value, parameters, types2, o) {
  return value instanceof Builder ? value.build(string, parameters, types2, o) : value instanceof Query ? fragment(value, parameters, types2, o) : value instanceof Identifier ? value.value : value && value[0] instanceof Query ? value.reduce((acc, x) => acc + " " + fragment(x, parameters, types2, o), "") : handleValue(value, parameters, types2, o);
}
function fragment(q, parameters, types2, options) {
  q.fragment = true;
  return stringify(q, q.strings[0], q.args[0], parameters, types2, options);
}
function valuesBuilder(first, parameters, types2, columns, options) {
  return first.map(
    (row) => "(" + columns.map(
      (column) => stringifyValue("values", row[column], parameters, types2, options)
    ).join(",") + ")"
  ).join(",");
}
function values(first, rest, parameters, types2, options) {
  const multi = Array.isArray(first[0]);
  const columns = rest.length ? rest.flat() : Object.keys(multi ? first[0] : first);
  return valuesBuilder(multi ? first : [first], parameters, types2, columns, options);
}
function select(first, rest, parameters, types2, options) {
  typeof first === "string" && (first = [first].concat(rest));
  if (Array.isArray(first))
    return escapeIdentifiers(first, options);
  let value;
  const columns = rest.length ? rest.flat() : Object.keys(first);
  return columns.map((x) => {
    value = first[x];
    return (value instanceof Query ? fragment(value, parameters, types2, options) : value instanceof Identifier ? value.value : handleValue(value, parameters, types2, options)) + " as " + escapeIdentifier(options.transform.column.to ? options.transform.column.to(x) : x);
  }).join(",");
}
var builders = Object.entries({
  values,
  in: (...xs) => {
    const x = values(...xs);
    return x === "()" ? "(null)" : x;
  },
  select,
  as: select,
  returning: select,
  "\\(": select,
  update(first, rest, parameters, types2, options) {
    return (rest.length ? rest.flat() : Object.keys(first)).map(
      (x) => escapeIdentifier(options.transform.column.to ? options.transform.column.to(x) : x) + "=" + stringifyValue("values", first[x], parameters, types2, options)
    );
  },
  insert(first, rest, parameters, types2, options) {
    const columns = rest.length ? rest.flat() : Object.keys(Array.isArray(first) ? first[0] : first);
    return "(" + escapeIdentifiers(columns, options) + ")values" + valuesBuilder(Array.isArray(first) ? first : [first], parameters, types2, columns, options);
  }
}).map(([x, fn]) => [new RegExp("((?:^|[\\s(])" + x + "(?:$|[\\s(]))(?![\\s\\S]*\\1)", "i"), fn]);
function notTagged() {
  throw Errors.generic("NOT_TAGGED_CALL", "Query not called as a tagged template literal");
}
var serializers = defaultHandlers.serializers;
var parsers = defaultHandlers.parsers;
function firstIsString(x) {
  if (Array.isArray(x))
    return firstIsString(x[0]);
  return typeof x === "string" ? 1009 : 0;
}
var mergeUserTypes = function(types2) {
  const user = typeHandlers(types2 || {});
  return {
    serializers: Object.assign({}, serializers, user.serializers),
    parsers: Object.assign({}, parsers, user.parsers)
  };
};
function typeHandlers(types2) {
  return Object.keys(types2).reduce((acc, k) => {
    types2[k].from && [].concat(types2[k].from).forEach((x) => acc.parsers[x] = types2[k].parse);
    if (types2[k].serialize) {
      acc.serializers[types2[k].to] = types2[k].serialize;
      types2[k].from && [].concat(types2[k].from).forEach((x) => acc.serializers[x] = types2[k].serialize);
    }
    return acc;
  }, { parsers: {}, serializers: {} });
}
function escapeIdentifiers(xs, { transform: { column } }) {
  return xs.map((x) => escapeIdentifier(column.to ? column.to(x) : x)).join(",");
}
var escapeIdentifier = function escape(str) {
  return '"' + str.replace(/"/g, '""').replace(/\./g, '"."') + '"';
};
var inferType = function inferType2(x) {
  return x instanceof Parameter ? x.type : x instanceof Date ? 1184 : x instanceof Uint8Array ? 17 : x === true || x === false ? 16 : typeof x === "bigint" ? 20 : Array.isArray(x) ? inferType2(x[0]) : 0;
};
var escapeBackslash = /\\/g;
var escapeQuote = /"/g;
function arrayEscape(x) {
  return x.replace(escapeBackslash, "\\\\").replace(escapeQuote, '\\"');
}
var arraySerializer = function arraySerializer2(xs, serializer, options, typarray) {
  if (Array.isArray(xs) === false)
    return xs;
  if (!xs.length)
    return "{}";
  const first = xs[0];
  const delimiter = typarray === 1020 ? ";" : ",";
  if (Array.isArray(first) && !first.type)
    return "{" + xs.map((x) => arraySerializer2(x, serializer, options, typarray)).join(delimiter) + "}";
  return "{" + xs.map((x) => {
    if (x === void 0) {
      x = options.transform.undefined;
      if (x === void 0)
        throw Errors.generic("UNDEFINED_VALUE", "Undefined values are not allowed");
    }
    return x === null ? "null" : '"' + arrayEscape(serializer ? serializer(x.type ? x.value : x) : "" + x) + '"';
  }).join(delimiter) + "}";
};
var arrayParserState = {
  i: 0,
  char: null,
  str: "",
  quoted: false,
  last: 0
};
var arrayParser = function arrayParser2(x, parser, typarray) {
  arrayParserState.i = arrayParserState.last = 0;
  return arrayParserLoop(arrayParserState, x, parser, typarray);
};
function arrayParserLoop(s, x, parser, typarray) {
  const xs = [];
  const delimiter = typarray === 1020 ? ";" : ",";
  for (; s.i < x.length; s.i++) {
    s.char = x[s.i];
    if (s.quoted) {
      if (s.char === "\\") {
        s.str += x[++s.i];
      } else if (s.char === '"') {
        xs.push(parser ? parser(s.str) : s.str);
        s.str = "";
        s.quoted = x[s.i + 1] === '"';
        s.last = s.i + 2;
      } else {
        s.str += s.char;
      }
    } else if (s.char === '"') {
      s.quoted = true;
    } else if (s.char === "{") {
      s.last = ++s.i;
      xs.push(arrayParserLoop(s, x, parser, typarray));
    } else if (s.char === "}") {
      s.quoted = false;
      s.last < s.i && xs.push(parser ? parser(x.slice(s.last, s.i)) : x.slice(s.last, s.i));
      s.last = s.i + 1;
      break;
    } else if (s.char === delimiter && s.p !== "}" && s.p !== '"') {
      xs.push(parser ? parser(x.slice(s.last, s.i)) : x.slice(s.last, s.i));
      s.last = s.i + 1;
    }
    s.p = s.char;
  }
  s.last < s.i && xs.push(parser ? parser(x.slice(s.last, s.i + 1)) : x.slice(s.last, s.i + 1));
  return xs;
}
var toCamel = (x) => {
  let str = x[0];
  for (let i = 1; i < x.length; i++)
    str += x[i] === "_" ? x[++i].toUpperCase() : x[i];
  return str;
};
var toPascal = (x) => {
  let str = x[0].toUpperCase();
  for (let i = 1; i < x.length; i++)
    str += x[i] === "_" ? x[++i].toUpperCase() : x[i];
  return str;
};
var toKebab = (x) => x.replace(/_/g, "-");
var fromCamel = (x) => x.replace(/([A-Z])/g, "_$1").toLowerCase();
var fromPascal = (x) => (x.slice(0, 1) + x.slice(1).replace(/([A-Z])/g, "_$1")).toLowerCase();
var fromKebab = (x) => x.replace(/-/g, "_");
function createJsonTransform(fn) {
  return function jsonTransform(x, column) {
    return typeof x === "object" && x !== null && (column.type === 114 || column.type === 3802) ? Array.isArray(x) ? x.map((x2) => jsonTransform(x2, column)) : Object.entries(x).reduce((acc, [k, v]) => Object.assign(acc, { [fn(k)]: jsonTransform(v, column) }), {}) : x;
  };
}
toCamel.column = { from: toCamel };
toCamel.value = { from: createJsonTransform(toCamel) };
fromCamel.column = { to: fromCamel };
var camel = { ...toCamel };
camel.column.to = fromCamel;
toPascal.column = { from: toPascal };
toPascal.value = { from: createJsonTransform(toPascal) };
fromPascal.column = { to: fromPascal };
var pascal = { ...toPascal };
pascal.column.to = fromPascal;
toKebab.column = { from: toKebab };
toKebab.value = { from: createJsonTransform(toKebab) };
fromKebab.column = { to: fromKebab };
var kebab = { ...toKebab };
kebab.column.to = fromKebab;

// node_modules/.pnpm/postgres@3.4.8/node_modules/postgres/src/connection.js
import net from "net";
import tls from "tls";
import crypto2 from "crypto";
import Stream from "stream";
import { performance } from "perf_hooks";

// node_modules/.pnpm/postgres@3.4.8/node_modules/postgres/src/result.js
var Result = class extends Array {
  constructor() {
    super();
    Object.defineProperties(this, {
      count: { value: null, writable: true },
      state: { value: null, writable: true },
      command: { value: null, writable: true },
      columns: { value: null, writable: true },
      statement: { value: null, writable: true }
    });
  }
  static get [Symbol.species]() {
    return Array;
  }
};

// node_modules/.pnpm/postgres@3.4.8/node_modules/postgres/src/queue.js
var queue_default = Queue;
function Queue(initial = []) {
  let xs = initial.slice();
  let index2 = 0;
  return {
    get length() {
      return xs.length - index2;
    },
    remove: (x) => {
      const index3 = xs.indexOf(x);
      return index3 === -1 ? null : (xs.splice(index3, 1), x);
    },
    push: (x) => (xs.push(x), x),
    shift: () => {
      const out = xs[index2++];
      if (index2 === xs.length) {
        index2 = 0;
        xs = [];
      } else {
        xs[index2 - 1] = void 0;
      }
      return out;
    }
  };
}

// node_modules/.pnpm/postgres@3.4.8/node_modules/postgres/src/bytes.js
var size = 256;
var buffer = Buffer.allocUnsafe(size);
var messages = "BCcDdEFfHPpQSX".split("").reduce((acc, x) => {
  const v = x.charCodeAt(0);
  acc[x] = () => {
    buffer[0] = v;
    b.i = 5;
    return b;
  };
  return acc;
}, {});
var b = Object.assign(reset, messages, {
  N: String.fromCharCode(0),
  i: 0,
  inc(x) {
    b.i += x;
    return b;
  },
  str(x) {
    const length = Buffer.byteLength(x);
    fit(length);
    b.i += buffer.write(x, b.i, length, "utf8");
    return b;
  },
  i16(x) {
    fit(2);
    buffer.writeUInt16BE(x, b.i);
    b.i += 2;
    return b;
  },
  i32(x, i) {
    if (i || i === 0) {
      buffer.writeUInt32BE(x, i);
      return b;
    }
    fit(4);
    buffer.writeUInt32BE(x, b.i);
    b.i += 4;
    return b;
  },
  z(x) {
    fit(x);
    buffer.fill(0, b.i, b.i + x);
    b.i += x;
    return b;
  },
  raw(x) {
    buffer = Buffer.concat([buffer.subarray(0, b.i), x]);
    b.i = buffer.length;
    return b;
  },
  end(at = 1) {
    buffer.writeUInt32BE(b.i - at, at);
    const out = buffer.subarray(0, b.i);
    b.i = 0;
    buffer = Buffer.allocUnsafe(size);
    return out;
  }
});
var bytes_default = b;
function fit(x) {
  if (buffer.length - b.i < x) {
    const prev = buffer, length = prev.length;
    buffer = Buffer.allocUnsafe(length + (length >> 1) + x);
    prev.copy(buffer);
  }
}
function reset() {
  b.i = 0;
  return b;
}

// node_modules/.pnpm/postgres@3.4.8/node_modules/postgres/src/connection.js
var connection_default = Connection;
var uid = 1;
var Sync = bytes_default().S().end();
var Flush = bytes_default().H().end();
var SSLRequest = bytes_default().i32(8).i32(80877103).end(8);
var ExecuteUnnamed = Buffer.concat([bytes_default().E().str(bytes_default.N).i32(0).end(), Sync]);
var DescribeUnnamed = bytes_default().D().str("S").str(bytes_default.N).end();
var noop = () => {
};
var retryRoutines = /* @__PURE__ */ new Set([
  "FetchPreparedStatement",
  "RevalidateCachedQuery",
  "transformAssignedExpr"
]);
var errorFields = {
  83: "severity_local",
  // S
  86: "severity",
  // V
  67: "code",
  // C
  77: "message",
  // M
  68: "detail",
  // D
  72: "hint",
  // H
  80: "position",
  // P
  112: "internal_position",
  // p
  113: "internal_query",
  // q
  87: "where",
  // W
  115: "schema_name",
  // s
  116: "table_name",
  // t
  99: "column_name",
  // c
  100: "data type_name",
  // d
  110: "constraint_name",
  // n
  70: "file",
  // F
  76: "line",
  // L
  82: "routine"
  // R
};
function Connection(options, queues = {}, { onopen = noop, onend = noop, onclose = noop } = {}) {
  const {
    sslnegotiation,
    ssl,
    max,
    user,
    host,
    port,
    database,
    parsers: parsers2,
    transform,
    onnotice,
    onnotify,
    onparameter,
    max_pipeline,
    keep_alive,
    backoff: backoff2,
    target_session_attrs
  } = options;
  const sent = queue_default(), id = uid++, backend = { pid: null, secret: null }, idleTimer = timer(end, options.idle_timeout), lifeTimer = timer(end, options.max_lifetime), connectTimer = timer(connectTimedOut, options.connect_timeout);
  let socket = null, cancelMessage, errorResponse = null, result = new Result(), incoming = Buffer.alloc(0), needsTypes = options.fetch_types, backendParameters = {}, statements = {}, statementId = Math.random().toString(36).slice(2), statementCount = 1, closedTime = 0, remaining = 0, hostIndex = 0, retries = 0, length = 0, delay = 0, rows = 0, serverSignature = null, nextWriteTimer = null, terminated = false, incomings = null, results = null, initial = null, ending = null, stream = null, chunk = null, ended = null, nonce = null, query = null, final = null;
  const connection2 = {
    queue: queues.closed,
    idleTimer,
    connect(query2) {
      initial = query2;
      reconnect();
    },
    terminate,
    execute,
    cancel,
    end,
    count: 0,
    id
  };
  queues.closed && queues.closed.push(connection2);
  return connection2;
  async function createSocket() {
    let x;
    try {
      x = options.socket ? await Promise.resolve(options.socket(options)) : new net.Socket();
    } catch (e) {
      error(e);
      return;
    }
    x.on("error", error);
    x.on("close", closed);
    x.on("drain", drain);
    return x;
  }
  async function cancel({ pid, secret }, resolve, reject) {
    try {
      cancelMessage = bytes_default().i32(16).i32(80877102).i32(pid).i32(secret).end(16);
      await connect();
      socket.once("error", reject);
      socket.once("close", resolve);
    } catch (error2) {
      reject(error2);
    }
  }
  function execute(q) {
    if (terminated)
      return queryError(q, Errors.connection("CONNECTION_DESTROYED", options));
    if (stream)
      return queryError(q, Errors.generic("COPY_IN_PROGRESS", "You cannot execute queries during copy"));
    if (q.cancelled)
      return;
    try {
      q.state = backend;
      query ? sent.push(q) : (query = q, query.active = true);
      build(q);
      return write(toBuffer(q)) && !q.describeFirst && !q.cursorFn && sent.length < max_pipeline && (!q.options.onexecute || q.options.onexecute(connection2));
    } catch (error2) {
      sent.length === 0 && write(Sync);
      errored(error2);
      return true;
    }
  }
  function toBuffer(q) {
    if (q.parameters.length >= 65534)
      throw Errors.generic("MAX_PARAMETERS_EXCEEDED", "Max number of parameters (65534) exceeded");
    return q.options.simple ? bytes_default().Q().str(q.statement.string + bytes_default.N).end() : q.describeFirst ? Buffer.concat([describe(q), Flush]) : q.prepare ? q.prepared ? prepared(q) : Buffer.concat([describe(q), prepared(q)]) : unnamed(q);
  }
  function describe(q) {
    return Buffer.concat([
      Parse(q.statement.string, q.parameters, q.statement.types, q.statement.name),
      Describe("S", q.statement.name)
    ]);
  }
  function prepared(q) {
    return Buffer.concat([
      Bind(q.parameters, q.statement.types, q.statement.name, q.cursorName),
      q.cursorFn ? Execute("", q.cursorRows) : ExecuteUnnamed
    ]);
  }
  function unnamed(q) {
    return Buffer.concat([
      Parse(q.statement.string, q.parameters, q.statement.types),
      DescribeUnnamed,
      prepared(q)
    ]);
  }
  function build(q) {
    const parameters = [], types2 = [];
    const string = stringify(q, q.strings[0], q.args[0], parameters, types2, options);
    !q.tagged && q.args.forEach((x) => handleValue(x, parameters, types2, options));
    q.prepare = options.prepare && ("prepare" in q.options ? q.options.prepare : true);
    q.string = string;
    q.signature = q.prepare && types2 + string;
    q.onlyDescribe && delete statements[q.signature];
    q.parameters = q.parameters || parameters;
    q.prepared = q.prepare && q.signature in statements;
    q.describeFirst = q.onlyDescribe || parameters.length && !q.prepared;
    q.statement = q.prepared ? statements[q.signature] : { string, types: types2, name: q.prepare ? statementId + statementCount++ : "" };
    typeof options.debug === "function" && options.debug(id, string, parameters, types2);
  }
  function write(x, fn) {
    chunk = chunk ? Buffer.concat([chunk, x]) : Buffer.from(x);
    if (fn || chunk.length >= 1024)
      return nextWrite(fn);
    nextWriteTimer === null && (nextWriteTimer = setImmediate(nextWrite));
    return true;
  }
  function nextWrite(fn) {
    const x = socket.write(chunk, fn);
    nextWriteTimer !== null && clearImmediate(nextWriteTimer);
    chunk = nextWriteTimer = null;
    return x;
  }
  function connectTimedOut() {
    errored(Errors.connection("CONNECT_TIMEOUT", options, socket));
    socket.destroy();
  }
  async function secure() {
    if (sslnegotiation !== "direct") {
      write(SSLRequest);
      const canSSL = await new Promise((r) => socket.once("data", (x) => r(x[0] === 83)));
      if (!canSSL && ssl === "prefer")
        return connected();
    }
    const options2 = {
      socket,
      servername: net.isIP(socket.host) ? void 0 : socket.host
    };
    if (sslnegotiation === "direct")
      options2.ALPNProtocols = ["postgresql"];
    if (ssl === "require" || ssl === "allow" || ssl === "prefer")
      options2.rejectUnauthorized = false;
    else if (typeof ssl === "object")
      Object.assign(options2, ssl);
    socket.removeAllListeners();
    socket = tls.connect(options2);
    socket.on("secureConnect", connected);
    socket.on("error", error);
    socket.on("close", closed);
    socket.on("drain", drain);
  }
  function drain() {
    !query && onopen(connection2);
  }
  function data(x) {
    if (incomings) {
      incomings.push(x);
      remaining -= x.length;
      if (remaining > 0)
        return;
    }
    incoming = incomings ? Buffer.concat(incomings, length - remaining) : incoming.length === 0 ? x : Buffer.concat([incoming, x], incoming.length + x.length);
    while (incoming.length > 4) {
      length = incoming.readUInt32BE(1);
      if (length >= incoming.length) {
        remaining = length - incoming.length;
        incomings = [incoming];
        break;
      }
      try {
        handle(incoming.subarray(0, length + 1));
      } catch (e) {
        query && (query.cursorFn || query.describeFirst) && write(Sync);
        errored(e);
      }
      incoming = incoming.subarray(length + 1);
      remaining = 0;
      incomings = null;
    }
  }
  async function connect() {
    terminated = false;
    backendParameters = {};
    socket || (socket = await createSocket());
    if (!socket)
      return;
    connectTimer.start();
    if (options.socket)
      return ssl ? secure() : connected();
    socket.on("connect", ssl ? secure : connected);
    if (options.path)
      return socket.connect(options.path);
    socket.ssl = ssl;
    socket.connect(port[hostIndex], host[hostIndex]);
    socket.host = host[hostIndex];
    socket.port = port[hostIndex];
    hostIndex = (hostIndex + 1) % port.length;
  }
  function reconnect() {
    setTimeout(connect, closedTime ? Math.max(0, closedTime + delay - performance.now()) : 0);
  }
  function connected() {
    try {
      statements = {};
      needsTypes = options.fetch_types;
      statementId = Math.random().toString(36).slice(2);
      statementCount = 1;
      lifeTimer.start();
      socket.on("data", data);
      keep_alive && socket.setKeepAlive && socket.setKeepAlive(true, 1e3 * keep_alive);
      const s = StartupMessage();
      write(s);
    } catch (err) {
      error(err);
    }
  }
  function error(err) {
    if (connection2.queue === queues.connecting && options.host[retries + 1])
      return;
    errored(err);
    while (sent.length)
      queryError(sent.shift(), err);
  }
  function errored(err) {
    stream && (stream.destroy(err), stream = null);
    query && queryError(query, err);
    initial && (queryError(initial, err), initial = null);
  }
  function queryError(query2, err) {
    if (query2.reserve)
      return query2.reject(err);
    if (!err || typeof err !== "object")
      err = new Error(err);
    "query" in err || "parameters" in err || Object.defineProperties(err, {
      stack: { value: err.stack + query2.origin.replace(/.*\n/, "\n"), enumerable: options.debug },
      query: { value: query2.string, enumerable: options.debug },
      parameters: { value: query2.parameters, enumerable: options.debug },
      args: { value: query2.args, enumerable: options.debug },
      types: { value: query2.statement && query2.statement.types, enumerable: options.debug }
    });
    query2.reject(err);
  }
  function end() {
    return ending || (!connection2.reserved && onend(connection2), !connection2.reserved && !initial && !query && sent.length === 0 ? (terminate(), new Promise((r) => socket && socket.readyState !== "closed" ? socket.once("close", r) : r())) : ending = new Promise((r) => ended = r));
  }
  function terminate() {
    terminated = true;
    if (stream || query || initial || sent.length)
      error(Errors.connection("CONNECTION_DESTROYED", options));
    clearImmediate(nextWriteTimer);
    if (socket) {
      socket.removeListener("data", data);
      socket.removeListener("connect", connected);
      socket.readyState === "open" && socket.end(bytes_default().X().end());
    }
    ended && (ended(), ending = ended = null);
  }
  async function closed(hadError) {
    incoming = Buffer.alloc(0);
    remaining = 0;
    incomings = null;
    clearImmediate(nextWriteTimer);
    socket.removeListener("data", data);
    socket.removeListener("connect", connected);
    idleTimer.cancel();
    lifeTimer.cancel();
    connectTimer.cancel();
    socket.removeAllListeners();
    socket = null;
    if (initial)
      return reconnect();
    !hadError && (query || sent.length) && error(Errors.connection("CONNECTION_CLOSED", options, socket));
    closedTime = performance.now();
    hadError && options.shared.retries++;
    delay = (typeof backoff2 === "function" ? backoff2(options.shared.retries) : backoff2) * 1e3;
    onclose(connection2, Errors.connection("CONNECTION_CLOSED", options, socket));
  }
  function handle(xs, x = xs[0]) {
    (x === 68 ? DataRow : (
      // D
      x === 100 ? CopyData : (
        // d
        x === 65 ? NotificationResponse : (
          // A
          x === 83 ? ParameterStatus : (
            // S
            x === 90 ? ReadyForQuery : (
              // Z
              x === 67 ? CommandComplete : (
                // C
                x === 50 ? BindComplete : (
                  // 2
                  x === 49 ? ParseComplete : (
                    // 1
                    x === 116 ? ParameterDescription : (
                      // t
                      x === 84 ? RowDescription : (
                        // T
                        x === 82 ? Authentication : (
                          // R
                          x === 110 ? NoData : (
                            // n
                            x === 75 ? BackendKeyData : (
                              // K
                              x === 69 ? ErrorResponse : (
                                // E
                                x === 115 ? PortalSuspended : (
                                  // s
                                  x === 51 ? CloseComplete : (
                                    // 3
                                    x === 71 ? CopyInResponse : (
                                      // G
                                      x === 78 ? NoticeResponse : (
                                        // N
                                        x === 72 ? CopyOutResponse : (
                                          // H
                                          x === 99 ? CopyDone : (
                                            // c
                                            x === 73 ? EmptyQueryResponse : (
                                              // I
                                              x === 86 ? FunctionCallResponse : (
                                                // V
                                                x === 118 ? NegotiateProtocolVersion : (
                                                  // v
                                                  x === 87 ? CopyBothResponse : (
                                                    // W
                                                    /* c8 ignore next */
                                                    UnknownMessage
                                                  )
                                                )
                                              )
                                            )
                                          )
                                        )
                                      )
                                    )
                                  )
                                )
                              )
                            )
                          )
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        )
      )
    ))(xs);
  }
  function DataRow(x) {
    let index2 = 7;
    let length2;
    let column;
    let value;
    const row = query.isRaw ? new Array(query.statement.columns.length) : {};
    for (let i = 0; i < query.statement.columns.length; i++) {
      column = query.statement.columns[i];
      length2 = x.readInt32BE(index2);
      index2 += 4;
      value = length2 === -1 ? null : query.isRaw === true ? x.subarray(index2, index2 += length2) : column.parser === void 0 ? x.toString("utf8", index2, index2 += length2) : column.parser.array === true ? column.parser(x.toString("utf8", index2 + 1, index2 += length2)) : column.parser(x.toString("utf8", index2, index2 += length2));
      query.isRaw ? row[i] = query.isRaw === true ? value : transform.value.from ? transform.value.from(value, column) : value : row[column.name] = transform.value.from ? transform.value.from(value, column) : value;
    }
    query.forEachFn ? query.forEachFn(transform.row.from ? transform.row.from(row) : row, result) : result[rows++] = transform.row.from ? transform.row.from(row) : row;
  }
  function ParameterStatus(x) {
    const [k, v] = x.toString("utf8", 5, x.length - 1).split(bytes_default.N);
    backendParameters[k] = v;
    if (options.parameters[k] !== v) {
      options.parameters[k] = v;
      onparameter && onparameter(k, v);
    }
  }
  function ReadyForQuery(x) {
    if (query) {
      if (errorResponse) {
        query.retried ? errored(query.retried) : query.prepared && retryRoutines.has(errorResponse.routine) ? retry(query, errorResponse) : errored(errorResponse);
      } else {
        query.resolve(results || result);
      }
    } else if (errorResponse) {
      errored(errorResponse);
    }
    query = results = errorResponse = null;
    result = new Result();
    connectTimer.cancel();
    if (initial) {
      if (target_session_attrs) {
        if (!backendParameters.in_hot_standby || !backendParameters.default_transaction_read_only)
          return fetchState();
        else if (tryNext(target_session_attrs, backendParameters))
          return terminate();
      }
      if (needsTypes) {
        initial.reserve && (initial = null);
        return fetchArrayTypes();
      }
      initial && !initial.reserve && execute(initial);
      options.shared.retries = retries = 0;
      initial = null;
      return;
    }
    while (sent.length && (query = sent.shift()) && (query.active = true, query.cancelled))
      Connection(options).cancel(query.state, query.cancelled.resolve, query.cancelled.reject);
    if (query)
      return;
    connection2.reserved ? !connection2.reserved.release && x[5] === 73 ? ending ? terminate() : (connection2.reserved = null, onopen(connection2)) : connection2.reserved() : ending ? terminate() : onopen(connection2);
  }
  function CommandComplete(x) {
    rows = 0;
    for (let i = x.length - 1; i > 0; i--) {
      if (x[i] === 32 && x[i + 1] < 58 && result.count === null)
        result.count = +x.toString("utf8", i + 1, x.length - 1);
      if (x[i - 1] >= 65) {
        result.command = x.toString("utf8", 5, i);
        result.state = backend;
        break;
      }
    }
    final && (final(), final = null);
    if (result.command === "BEGIN" && max !== 1 && !connection2.reserved)
      return errored(Errors.generic("UNSAFE_TRANSACTION", "Only use sql.begin, sql.reserved or max: 1"));
    if (query.options.simple)
      return BindComplete();
    if (query.cursorFn) {
      result.count && query.cursorFn(result);
      write(Sync);
    }
  }
  function ParseComplete() {
    query.parsing = false;
  }
  function BindComplete() {
    !result.statement && (result.statement = query.statement);
    result.columns = query.statement.columns;
  }
  function ParameterDescription(x) {
    const length2 = x.readUInt16BE(5);
    for (let i = 0; i < length2; ++i)
      !query.statement.types[i] && (query.statement.types[i] = x.readUInt32BE(7 + i * 4));
    query.prepare && (statements[query.signature] = query.statement);
    query.describeFirst && !query.onlyDescribe && (write(prepared(query)), query.describeFirst = false);
  }
  function RowDescription(x) {
    if (result.command) {
      results = results || [result];
      results.push(result = new Result());
      result.count = null;
      query.statement.columns = null;
    }
    const length2 = x.readUInt16BE(5);
    let index2 = 7;
    let start;
    query.statement.columns = Array(length2);
    for (let i = 0; i < length2; ++i) {
      start = index2;
      while (x[index2++] !== 0) ;
      const table = x.readUInt32BE(index2);
      const number = x.readUInt16BE(index2 + 4);
      const type = x.readUInt32BE(index2 + 6);
      query.statement.columns[i] = {
        name: transform.column.from ? transform.column.from(x.toString("utf8", start, index2 - 1)) : x.toString("utf8", start, index2 - 1),
        parser: parsers2[type],
        table,
        number,
        type
      };
      index2 += 18;
    }
    result.statement = query.statement;
    if (query.onlyDescribe)
      return query.resolve(query.statement), write(Sync);
  }
  async function Authentication(x, type = x.readUInt32BE(5)) {
    (type === 3 ? AuthenticationCleartextPassword : type === 5 ? AuthenticationMD5Password : type === 10 ? SASL : type === 11 ? SASLContinue : type === 12 ? SASLFinal : type !== 0 ? UnknownAuth : noop)(x, type);
  }
  async function AuthenticationCleartextPassword() {
    const payload = await Pass();
    write(
      bytes_default().p().str(payload).z(1).end()
    );
  }
  async function AuthenticationMD5Password(x) {
    const payload = "md5" + await md5(
      Buffer.concat([
        Buffer.from(await md5(await Pass() + user)),
        x.subarray(9)
      ])
    );
    write(
      bytes_default().p().str(payload).z(1).end()
    );
  }
  async function SASL() {
    nonce = (await crypto2.randomBytes(18)).toString("base64");
    bytes_default().p().str("SCRAM-SHA-256" + bytes_default.N);
    const i = bytes_default.i;
    write(bytes_default.inc(4).str("n,,n=*,r=" + nonce).i32(bytes_default.i - i - 4, i).end());
  }
  async function SASLContinue(x) {
    const res = x.toString("utf8", 9).split(",").reduce((acc, x2) => (acc[x2[0]] = x2.slice(2), acc), {});
    const saltedPassword = await crypto2.pbkdf2Sync(
      await Pass(),
      Buffer.from(res.s, "base64"),
      parseInt(res.i),
      32,
      "sha256"
    );
    const clientKey = await hmac(saltedPassword, "Client Key");
    const auth = "n=*,r=" + nonce + ",r=" + res.r + ",s=" + res.s + ",i=" + res.i + ",c=biws,r=" + res.r;
    serverSignature = (await hmac(await hmac(saltedPassword, "Server Key"), auth)).toString("base64");
    const payload = "c=biws,r=" + res.r + ",p=" + xor(
      clientKey,
      Buffer.from(await hmac(await sha256(clientKey), auth))
    ).toString("base64");
    write(
      bytes_default().p().str(payload).end()
    );
  }
  function SASLFinal(x) {
    if (x.toString("utf8", 9).split(bytes_default.N, 1)[0].slice(2) === serverSignature)
      return;
    errored(Errors.generic("SASL_SIGNATURE_MISMATCH", "The server did not return the correct signature"));
    socket.destroy();
  }
  function Pass() {
    return Promise.resolve(
      typeof options.pass === "function" ? options.pass() : options.pass
    );
  }
  function NoData() {
    result.statement = query.statement;
    result.statement.columns = [];
    if (query.onlyDescribe)
      return query.resolve(query.statement), write(Sync);
  }
  function BackendKeyData(x) {
    backend.pid = x.readUInt32BE(5);
    backend.secret = x.readUInt32BE(9);
  }
  async function fetchArrayTypes() {
    needsTypes = false;
    const types2 = await new Query([`
      select b.oid, b.typarray
      from pg_catalog.pg_type a
      left join pg_catalog.pg_type b on b.oid = a.typelem
      where a.typcategory = 'A'
      group by b.oid, b.typarray
      order by b.oid
    `], [], execute);
    types2.forEach(({ oid, typarray }) => addArrayType(oid, typarray));
  }
  function addArrayType(oid, typarray) {
    if (!!options.parsers[typarray] && !!options.serializers[typarray]) return;
    const parser = options.parsers[oid];
    options.shared.typeArrayMap[oid] = typarray;
    options.parsers[typarray] = (xs) => arrayParser(xs, parser, typarray);
    options.parsers[typarray].array = true;
    options.serializers[typarray] = (xs) => arraySerializer(xs, options.serializers[oid], options, typarray);
  }
  function tryNext(x, xs) {
    return x === "read-write" && xs.default_transaction_read_only === "on" || x === "read-only" && xs.default_transaction_read_only === "off" || x === "primary" && xs.in_hot_standby === "on" || x === "standby" && xs.in_hot_standby === "off" || x === "prefer-standby" && xs.in_hot_standby === "off" && options.host[retries];
  }
  function fetchState() {
    const query2 = new Query([`
      show transaction_read_only;
      select pg_catalog.pg_is_in_recovery()
    `], [], execute, null, { simple: true });
    query2.resolve = ([[a], [b2]]) => {
      backendParameters.default_transaction_read_only = a.transaction_read_only;
      backendParameters.in_hot_standby = b2.pg_is_in_recovery ? "on" : "off";
    };
    query2.execute();
  }
  function ErrorResponse(x) {
    if (query) {
      (query.cursorFn || query.describeFirst) && write(Sync);
      errorResponse = Errors.postgres(parseError(x));
    } else {
      errored(Errors.postgres(parseError(x)));
    }
  }
  function retry(q, error2) {
    delete statements[q.signature];
    q.retried = error2;
    execute(q);
  }
  function NotificationResponse(x) {
    if (!onnotify)
      return;
    let index2 = 9;
    while (x[index2++] !== 0) ;
    onnotify(
      x.toString("utf8", 9, index2 - 1),
      x.toString("utf8", index2, x.length - 1)
    );
  }
  async function PortalSuspended() {
    try {
      const x = await Promise.resolve(query.cursorFn(result));
      rows = 0;
      x === CLOSE ? write(Close(query.portal)) : (result = new Result(), write(Execute("", query.cursorRows)));
    } catch (err) {
      write(Sync);
      query.reject(err);
    }
  }
  function CloseComplete() {
    result.count && query.cursorFn(result);
    query.resolve(result);
  }
  function CopyInResponse() {
    stream = new Stream.Writable({
      autoDestroy: true,
      write(chunk2, encoding, callback) {
        socket.write(bytes_default().d().raw(chunk2).end(), callback);
      },
      destroy(error2, callback) {
        callback(error2);
        socket.write(bytes_default().f().str(error2 + bytes_default.N).end());
        stream = null;
      },
      final(callback) {
        socket.write(bytes_default().c().end());
        final = callback;
        stream = null;
      }
    });
    query.resolve(stream);
  }
  function CopyOutResponse() {
    stream = new Stream.Readable({
      read() {
        socket.resume();
      }
    });
    query.resolve(stream);
  }
  function CopyBothResponse() {
    stream = new Stream.Duplex({
      autoDestroy: true,
      read() {
        socket.resume();
      },
      /* c8 ignore next 11 */
      write(chunk2, encoding, callback) {
        socket.write(bytes_default().d().raw(chunk2).end(), callback);
      },
      destroy(error2, callback) {
        callback(error2);
        socket.write(bytes_default().f().str(error2 + bytes_default.N).end());
        stream = null;
      },
      final(callback) {
        socket.write(bytes_default().c().end());
        final = callback;
      }
    });
    query.resolve(stream);
  }
  function CopyData(x) {
    stream && (stream.push(x.subarray(5)) || socket.pause());
  }
  function CopyDone() {
    stream && stream.push(null);
    stream = null;
  }
  function NoticeResponse(x) {
    onnotice ? onnotice(parseError(x)) : console.log(parseError(x));
  }
  function EmptyQueryResponse() {
  }
  function FunctionCallResponse() {
    errored(Errors.notSupported("FunctionCallResponse"));
  }
  function NegotiateProtocolVersion() {
    errored(Errors.notSupported("NegotiateProtocolVersion"));
  }
  function UnknownMessage(x) {
    console.error("Postgres.js : Unknown Message:", x[0]);
  }
  function UnknownAuth(x, type) {
    console.error("Postgres.js : Unknown Auth:", type);
  }
  function Bind(parameters, types2, statement = "", portal = "") {
    let prev, type;
    bytes_default().B().str(portal + bytes_default.N).str(statement + bytes_default.N).i16(0).i16(parameters.length);
    parameters.forEach((x, i) => {
      if (x === null)
        return bytes_default.i32(4294967295);
      type = types2[i];
      parameters[i] = x = type in options.serializers ? options.serializers[type](x) : "" + x;
      prev = bytes_default.i;
      bytes_default.inc(4).str(x).i32(bytes_default.i - prev - 4, prev);
    });
    bytes_default.i16(0);
    return bytes_default.end();
  }
  function Parse(str, parameters, types2, name = "") {
    bytes_default().P().str(name + bytes_default.N).str(str + bytes_default.N).i16(parameters.length);
    parameters.forEach((x, i) => bytes_default.i32(types2[i] || 0));
    return bytes_default.end();
  }
  function Describe(x, name = "") {
    return bytes_default().D().str(x).str(name + bytes_default.N).end();
  }
  function Execute(portal = "", rows2 = 0) {
    return Buffer.concat([
      bytes_default().E().str(portal + bytes_default.N).i32(rows2).end(),
      Flush
    ]);
  }
  function Close(portal = "") {
    return Buffer.concat([
      bytes_default().C().str("P").str(portal + bytes_default.N).end(),
      bytes_default().S().end()
    ]);
  }
  function StartupMessage() {
    return cancelMessage || bytes_default().inc(4).i16(3).z(2).str(
      Object.entries(Object.assign(
        {
          user,
          database,
          client_encoding: "UTF8"
        },
        options.connection
      )).filter(([, v]) => v).map(([k, v]) => k + bytes_default.N + v).join(bytes_default.N)
    ).z(2).end(0);
  }
}
function parseError(x) {
  const error = {};
  let start = 5;
  for (let i = 5; i < x.length - 1; i++) {
    if (x[i] === 0) {
      error[errorFields[x[start]]] = x.toString("utf8", start + 1, i);
      start = i + 1;
    }
  }
  return error;
}
function md5(x) {
  return crypto2.createHash("md5").update(x).digest("hex");
}
function hmac(key, x) {
  return crypto2.createHmac("sha256", key).update(x).digest();
}
function sha256(x) {
  return crypto2.createHash("sha256").update(x).digest();
}
function xor(a, b2) {
  const length = Math.max(a.length, b2.length);
  const buffer2 = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++)
    buffer2[i] = a[i] ^ b2[i];
  return buffer2;
}
function timer(fn, seconds) {
  seconds = typeof seconds === "function" ? seconds() : seconds;
  if (!seconds)
    return { cancel: noop, start: noop };
  let timer2;
  return {
    cancel() {
      timer2 && (clearTimeout(timer2), timer2 = null);
    },
    start() {
      timer2 && clearTimeout(timer2);
      timer2 = setTimeout(done, seconds * 1e3, arguments);
    }
  };
  function done(args) {
    fn.apply(null, args);
    timer2 = null;
  }
}

// node_modules/.pnpm/postgres@3.4.8/node_modules/postgres/src/subscribe.js
var noop2 = () => {
};
function Subscribe(postgres2, options) {
  const subscribers = /* @__PURE__ */ new Map(), slot = "postgresjs_" + Math.random().toString(36).slice(2), state = {};
  let connection2, stream, ended = false;
  const sql2 = subscribe.sql = postgres2({
    ...options,
    transform: { column: {}, value: {}, row: {} },
    max: 1,
    fetch_types: false,
    idle_timeout: null,
    max_lifetime: null,
    connection: {
      ...options.connection,
      replication: "database"
    },
    onclose: async function() {
      if (ended)
        return;
      stream = null;
      state.pid = state.secret = void 0;
      connected(await init(sql2, slot, options.publications));
      subscribers.forEach((event) => event.forEach(({ onsubscribe }) => onsubscribe()));
    },
    no_subscribe: true
  });
  const end = sql2.end, close = sql2.close;
  sql2.end = async () => {
    ended = true;
    stream && await new Promise((r) => (stream.once("close", r), stream.end()));
    return end();
  };
  sql2.close = async () => {
    stream && await new Promise((r) => (stream.once("close", r), stream.end()));
    return close();
  };
  return subscribe;
  async function subscribe(event, fn, onsubscribe = noop2, onerror = noop2) {
    event = parseEvent(event);
    if (!connection2)
      connection2 = init(sql2, slot, options.publications);
    const subscriber = { fn, onsubscribe };
    const fns = subscribers.has(event) ? subscribers.get(event).add(subscriber) : subscribers.set(event, /* @__PURE__ */ new Set([subscriber])).get(event);
    const unsubscribe = () => {
      fns.delete(subscriber);
      fns.size === 0 && subscribers.delete(event);
    };
    return connection2.then((x) => {
      connected(x);
      onsubscribe();
      stream && stream.on("error", onerror);
      return { unsubscribe, state, sql: sql2 };
    });
  }
  function connected(x) {
    stream = x.stream;
    state.pid = x.state.pid;
    state.secret = x.state.secret;
  }
  async function init(sql3, slot2, publications) {
    if (!publications)
      throw new Error("Missing publication names");
    const xs = await sql3.unsafe(
      `CREATE_REPLICATION_SLOT ${slot2} TEMPORARY LOGICAL pgoutput NOEXPORT_SNAPSHOT`
    );
    const [x] = xs;
    const stream2 = await sql3.unsafe(
      `START_REPLICATION SLOT ${slot2} LOGICAL ${x.consistent_point} (proto_version '1', publication_names '${publications}')`
    ).writable();
    const state2 = {
      lsn: Buffer.concat(x.consistent_point.split("/").map((x2) => Buffer.from(("00000000" + x2).slice(-8), "hex")))
    };
    stream2.on("data", data);
    stream2.on("error", error);
    stream2.on("close", sql3.close);
    return { stream: stream2, state: xs.state };
    function error(e) {
      console.error("Unexpected error during logical streaming - reconnecting", e);
    }
    function data(x2) {
      if (x2[0] === 119) {
        parse(x2.subarray(25), state2, sql3.options.parsers, handle, options.transform);
      } else if (x2[0] === 107 && x2[17]) {
        state2.lsn = x2.subarray(1, 9);
        pong();
      }
    }
    function handle(a, b2) {
      const path2 = b2.relation.schema + "." + b2.relation.table;
      call("*", a, b2);
      call("*:" + path2, a, b2);
      b2.relation.keys.length && call("*:" + path2 + "=" + b2.relation.keys.map((x2) => a[x2.name]), a, b2);
      call(b2.command, a, b2);
      call(b2.command + ":" + path2, a, b2);
      b2.relation.keys.length && call(b2.command + ":" + path2 + "=" + b2.relation.keys.map((x2) => a[x2.name]), a, b2);
    }
    function pong() {
      const x2 = Buffer.alloc(34);
      x2[0] = "r".charCodeAt(0);
      x2.fill(state2.lsn, 1);
      x2.writeBigInt64BE(BigInt(Date.now() - Date.UTC(2e3, 0, 1)) * BigInt(1e3), 25);
      stream2.write(x2);
    }
  }
  function call(x, a, b2) {
    subscribers.has(x) && subscribers.get(x).forEach(({ fn }) => fn(a, b2, x));
  }
}
function Time(x) {
  return new Date(Date.UTC(2e3, 0, 1) + Number(x / BigInt(1e3)));
}
function parse(x, state, parsers2, handle, transform) {
  const char2 = (acc, [k, v]) => (acc[k.charCodeAt(0)] = v, acc);
  Object.entries({
    R: (x2) => {
      let i = 1;
      const r = state[x2.readUInt32BE(i)] = {
        schema: x2.toString("utf8", i += 4, i = x2.indexOf(0, i)) || "pg_catalog",
        table: x2.toString("utf8", i + 1, i = x2.indexOf(0, i + 1)),
        columns: Array(x2.readUInt16BE(i += 2)),
        keys: []
      };
      i += 2;
      let columnIndex = 0, column;
      while (i < x2.length) {
        column = r.columns[columnIndex++] = {
          key: x2[i++],
          name: transform.column.from ? transform.column.from(x2.toString("utf8", i, i = x2.indexOf(0, i))) : x2.toString("utf8", i, i = x2.indexOf(0, i)),
          type: x2.readUInt32BE(i += 1),
          parser: parsers2[x2.readUInt32BE(i)],
          atttypmod: x2.readUInt32BE(i += 4)
        };
        column.key && r.keys.push(column);
        i += 4;
      }
    },
    Y: () => {
    },
    // Type
    O: () => {
    },
    // Origin
    B: (x2) => {
      state.date = Time(x2.readBigInt64BE(9));
      state.lsn = x2.subarray(1, 9);
    },
    I: (x2) => {
      let i = 1;
      const relation = state[x2.readUInt32BE(i)];
      const { row } = tuples(x2, relation.columns, i += 7, transform);
      handle(row, {
        command: "insert",
        relation
      });
    },
    D: (x2) => {
      let i = 1;
      const relation = state[x2.readUInt32BE(i)];
      i += 4;
      const key = x2[i] === 75;
      handle(
        key || x2[i] === 79 ? tuples(x2, relation.columns, i += 3, transform).row : null,
        {
          command: "delete",
          relation,
          key
        }
      );
    },
    U: (x2) => {
      let i = 1;
      const relation = state[x2.readUInt32BE(i)];
      i += 4;
      const key = x2[i] === 75;
      const xs = key || x2[i] === 79 ? tuples(x2, relation.columns, i += 3, transform) : null;
      xs && (i = xs.i);
      const { row } = tuples(x2, relation.columns, i + 3, transform);
      handle(row, {
        command: "update",
        relation,
        key,
        old: xs && xs.row
      });
    },
    T: () => {
    },
    // Truncate,
    C: () => {
    }
    // Commit
  }).reduce(char2, {})[x[0]](x);
}
function tuples(x, columns, xi, transform) {
  let type, column, value;
  const row = transform.raw ? new Array(columns.length) : {};
  for (let i = 0; i < columns.length; i++) {
    type = x[xi++];
    column = columns[i];
    value = type === 110 ? null : type === 117 ? void 0 : column.parser === void 0 ? x.toString("utf8", xi + 4, xi += 4 + x.readUInt32BE(xi)) : column.parser.array === true ? column.parser(x.toString("utf8", xi + 5, xi += 4 + x.readUInt32BE(xi))) : column.parser(x.toString("utf8", xi + 4, xi += 4 + x.readUInt32BE(xi)));
    transform.raw ? row[i] = transform.raw === true ? value : transform.value.from ? transform.value.from(value, column) : value : row[column.name] = transform.value.from ? transform.value.from(value, column) : value;
  }
  return { i: xi, row: transform.row.from ? transform.row.from(row) : row };
}
function parseEvent(x) {
  const xs = x.match(/^(\*|insert|update|delete)?:?([^.]+?\.?[^=]+)?=?(.+)?/i) || [];
  if (!xs)
    throw new Error("Malformed subscribe pattern: " + x);
  const [, command, path2, key] = xs;
  return (command || "*") + (path2 ? ":" + (path2.indexOf(".") === -1 ? "public." + path2 : path2) : "") + (key ? "=" + key : "");
}

// node_modules/.pnpm/postgres@3.4.8/node_modules/postgres/src/large.js
import Stream2 from "stream";
function largeObject(sql2, oid, mode = 131072 | 262144) {
  return new Promise(async (resolve, reject) => {
    await sql2.begin(async (sql3) => {
      let finish;
      !oid && ([{ oid }] = await sql3`select lo_creat(-1) as oid`);
      const [{ fd }] = await sql3`select lo_open(${oid}, ${mode}) as fd`;
      const lo = {
        writable,
        readable,
        close: () => sql3`select lo_close(${fd})`.then(finish),
        tell: () => sql3`select lo_tell64(${fd})`,
        read: (x) => sql3`select loread(${fd}, ${x}) as data`,
        write: (x) => sql3`select lowrite(${fd}, ${x})`,
        truncate: (x) => sql3`select lo_truncate64(${fd}, ${x})`,
        seek: (x, whence = 0) => sql3`select lo_lseek64(${fd}, ${x}, ${whence})`,
        size: () => sql3`
          select
            lo_lseek64(${fd}, location, 0) as position,
            seek.size
          from (
            select
              lo_lseek64($1, 0, 2) as size,
              tell.location
            from (select lo_tell64($1) as location) tell
          ) seek
        `
      };
      resolve(lo);
      return new Promise(async (r) => finish = r);
      async function readable({
        highWaterMark = 2048 * 8,
        start = 0,
        end = Infinity
      } = {}) {
        let max = end - start;
        start && await lo.seek(start);
        return new Stream2.Readable({
          highWaterMark,
          async read(size2) {
            const l = size2 > max ? size2 - max : size2;
            max -= size2;
            const [{ data }] = await lo.read(l);
            this.push(data);
            if (data.length < size2)
              this.push(null);
          }
        });
      }
      async function writable({
        highWaterMark = 2048 * 8,
        start = 0
      } = {}) {
        start && await lo.seek(start);
        return new Stream2.Writable({
          highWaterMark,
          write(chunk, encoding, callback) {
            lo.write(chunk).then(() => callback(), callback);
          }
        });
      }
    }).catch(reject);
  });
}

// node_modules/.pnpm/postgres@3.4.8/node_modules/postgres/src/index.js
Object.assign(Postgres, {
  PostgresError,
  toPascal,
  pascal,
  toCamel,
  camel,
  toKebab,
  kebab,
  fromPascal,
  fromCamel,
  fromKebab,
  BigInt: {
    to: 20,
    from: [20],
    parse: (x) => BigInt(x),
    // eslint-disable-line
    serialize: (x) => x.toString()
  }
});
var src_default = Postgres;
function Postgres(a, b2) {
  const options = parseOptions(a, b2), subscribe = options.no_subscribe || Subscribe(Postgres, { ...options });
  let ending = false;
  const queries = queue_default(), connecting = queue_default(), reserved = queue_default(), closed = queue_default(), ended = queue_default(), open = queue_default(), busy = queue_default(), full = queue_default(), queues = { connecting, reserved, closed, ended, open, busy, full };
  const connections = [...Array(options.max)].map(() => connection_default(options, queues, { onopen, onend, onclose }));
  const sql2 = Sql(handler);
  Object.assign(sql2, {
    get parameters() {
      return options.parameters;
    },
    largeObject: largeObject.bind(null, sql2),
    subscribe,
    CLOSE,
    END: CLOSE,
    PostgresError,
    options,
    reserve,
    listen,
    begin,
    close,
    end
  });
  return sql2;
  function Sql(handler2) {
    handler2.debug = options.debug;
    Object.entries(options.types).reduce((acc, [name, type]) => {
      acc[name] = (x) => new Parameter(x, type.to);
      return acc;
    }, typed);
    Object.assign(sql3, {
      types: typed,
      typed,
      unsafe,
      notify,
      array,
      json: json2,
      file
    });
    return sql3;
    function typed(value, type) {
      return new Parameter(value, type);
    }
    function sql3(strings, ...args) {
      const query = strings && Array.isArray(strings.raw) ? new Query(strings, args, handler2, cancel) : typeof strings === "string" && !args.length ? new Identifier(options.transform.column.to ? options.transform.column.to(strings) : strings) : new Builder(strings, args);
      return query;
    }
    function unsafe(string, args = [], options2 = {}) {
      arguments.length === 2 && !Array.isArray(args) && (options2 = args, args = []);
      const query = new Query([string], args, handler2, cancel, {
        prepare: false,
        ...options2,
        simple: "simple" in options2 ? options2.simple : args.length === 0
      });
      return query;
    }
    function file(path2, args = [], options2 = {}) {
      arguments.length === 2 && !Array.isArray(args) && (options2 = args, args = []);
      const query = new Query([], args, (query2) => {
        fs.readFile(path2, "utf8", (err, string) => {
          if (err)
            return query2.reject(err);
          query2.strings = [string];
          handler2(query2);
        });
      }, cancel, {
        ...options2,
        simple: "simple" in options2 ? options2.simple : args.length === 0
      });
      return query;
    }
  }
  async function listen(name, fn, onlisten) {
    const listener = { fn, onlisten };
    const sql3 = listen.sql || (listen.sql = Postgres({
      ...options,
      max: 1,
      idle_timeout: null,
      max_lifetime: null,
      fetch_types: false,
      onclose() {
        Object.entries(listen.channels).forEach(([name2, { listeners }]) => {
          delete listen.channels[name2];
          Promise.all(listeners.map((l) => listen(name2, l.fn, l.onlisten).catch(() => {
          })));
        });
      },
      onnotify(c, x) {
        c in listen.channels && listen.channels[c].listeners.forEach((l) => l.fn(x));
      }
    }));
    const channels = listen.channels || (listen.channels = {}), exists2 = name in channels;
    if (exists2) {
      channels[name].listeners.push(listener);
      const result2 = await channels[name].result;
      listener.onlisten && listener.onlisten();
      return { state: result2.state, unlisten };
    }
    channels[name] = { result: sql3`listen ${sql3.unsafe('"' + name.replace(/"/g, '""') + '"')}`, listeners: [listener] };
    const result = await channels[name].result;
    listener.onlisten && listener.onlisten();
    return { state: result.state, unlisten };
    async function unlisten() {
      if (name in channels === false)
        return;
      channels[name].listeners = channels[name].listeners.filter((x) => x !== listener);
      if (channels[name].listeners.length)
        return;
      delete channels[name];
      return sql3`unlisten ${sql3.unsafe('"' + name.replace(/"/g, '""') + '"')}`;
    }
  }
  async function notify(channel, payload) {
    return await sql2`select pg_notify(${channel}, ${"" + payload})`;
  }
  async function reserve() {
    const queue = queue_default();
    const c = open.length ? open.shift() : await new Promise((resolve, reject) => {
      const query = { reserve: resolve, reject };
      queries.push(query);
      closed.length && connect(closed.shift(), query);
    });
    move(c, reserved);
    c.reserved = () => queue.length ? c.execute(queue.shift()) : move(c, reserved);
    c.reserved.release = true;
    const sql3 = Sql(handler2);
    sql3.release = () => {
      c.reserved = null;
      onopen(c);
    };
    return sql3;
    function handler2(q) {
      c.queue === full ? queue.push(q) : c.execute(q) || move(c, full);
    }
  }
  async function begin(options2, fn) {
    !fn && (fn = options2, options2 = "");
    const queries2 = queue_default();
    let savepoints = 0, connection2, prepare = null;
    try {
      await sql2.unsafe("begin " + options2.replace(/[^a-z ]/ig, ""), [], { onexecute }).execute();
      return await Promise.race([
        scope(connection2, fn),
        new Promise((_, reject) => connection2.onclose = reject)
      ]);
    } catch (error) {
      throw error;
    }
    async function scope(c, fn2, name) {
      const sql3 = Sql(handler2);
      sql3.savepoint = savepoint;
      sql3.prepare = (x) => prepare = x.replace(/[^a-z0-9$-_. ]/gi);
      let uncaughtError, result;
      name && await sql3`savepoint ${sql3(name)}`;
      try {
        result = await new Promise((resolve, reject) => {
          const x = fn2(sql3);
          Promise.resolve(Array.isArray(x) ? Promise.all(x) : x).then(resolve, reject);
        });
        if (uncaughtError)
          throw uncaughtError;
      } catch (e) {
        await (name ? sql3`rollback to ${sql3(name)}` : sql3`rollback`);
        throw e instanceof PostgresError && e.code === "25P02" && uncaughtError || e;
      }
      if (!name) {
        prepare ? await sql3`prepare transaction '${sql3.unsafe(prepare)}'` : await sql3`commit`;
      }
      return result;
      function savepoint(name2, fn3) {
        if (name2 && Array.isArray(name2.raw))
          return savepoint((sql4) => sql4.apply(sql4, arguments));
        arguments.length === 1 && (fn3 = name2, name2 = null);
        return scope(c, fn3, "s" + savepoints++ + (name2 ? "_" + name2 : ""));
      }
      function handler2(q) {
        q.catch((e) => uncaughtError || (uncaughtError = e));
        c.queue === full ? queries2.push(q) : c.execute(q) || move(c, full);
      }
    }
    function onexecute(c) {
      connection2 = c;
      move(c, reserved);
      c.reserved = () => queries2.length ? c.execute(queries2.shift()) : move(c, reserved);
    }
  }
  function move(c, queue) {
    c.queue.remove(c);
    queue.push(c);
    c.queue = queue;
    queue === open ? c.idleTimer.start() : c.idleTimer.cancel();
    return c;
  }
  function json2(x) {
    return new Parameter(x, 3802);
  }
  function array(x, type) {
    if (!Array.isArray(x))
      return array(Array.from(arguments));
    return new Parameter(x, type || (x.length ? inferType(x) || 25 : 0), options.shared.typeArrayMap);
  }
  function handler(query) {
    if (ending)
      return query.reject(Errors.connection("CONNECTION_ENDED", options, options));
    if (open.length)
      return go(open.shift(), query);
    if (closed.length)
      return connect(closed.shift(), query);
    busy.length ? go(busy.shift(), query) : queries.push(query);
  }
  function go(c, query) {
    return c.execute(query) ? move(c, busy) : move(c, full);
  }
  function cancel(query) {
    return new Promise((resolve, reject) => {
      query.state ? query.active ? connection_default(options).cancel(query.state, resolve, reject) : query.cancelled = { resolve, reject } : (queries.remove(query), query.cancelled = true, query.reject(Errors.generic("57014", "canceling statement due to user request")), resolve());
    });
  }
  async function end({ timeout = null } = {}) {
    if (ending)
      return ending;
    await 1;
    let timer2;
    return ending = Promise.race([
      new Promise((r) => timeout !== null && (timer2 = setTimeout(destroy, timeout * 1e3, r))),
      Promise.all(connections.map((c) => c.end()).concat(
        listen.sql ? listen.sql.end({ timeout: 0 }) : [],
        subscribe.sql ? subscribe.sql.end({ timeout: 0 }) : []
      ))
    ]).then(() => clearTimeout(timer2));
  }
  async function close() {
    await Promise.all(connections.map((c) => c.end()));
  }
  async function destroy(resolve) {
    await Promise.all(connections.map((c) => c.terminate()));
    while (queries.length)
      queries.shift().reject(Errors.connection("CONNECTION_DESTROYED", options));
    resolve();
  }
  function connect(c, query) {
    move(c, connecting);
    c.connect(query);
    return c;
  }
  function onend(c) {
    move(c, ended);
  }
  function onopen(c) {
    if (queries.length === 0)
      return move(c, open);
    let max = Math.ceil(queries.length / (connecting.length + 1)), ready = true;
    while (ready && queries.length && max-- > 0) {
      const query = queries.shift();
      if (query.reserve)
        return query.reserve(c);
      ready = c.execute(query);
    }
    ready ? move(c, busy) : move(c, full);
  }
  function onclose(c, e) {
    move(c, closed);
    c.reserved = null;
    c.onclose && (c.onclose(e), c.onclose = null);
    options.onclose && options.onclose(c.id);
    queries.length && connect(c, queries.shift());
  }
}
function parseOptions(a, b2) {
  if (a && a.shared)
    return a;
  const env = process.env, o = (!a || typeof a === "string" ? b2 : a) || {}, { url, multihost } = parseUrl(a), query = [...url.searchParams].reduce((a2, [b3, c]) => (a2[b3] = c, a2), {}), host = o.hostname || o.host || multihost || url.hostname || env.PGHOST || "localhost", port = o.port || url.port || env.PGPORT || 5432, user = o.user || o.username || url.username || env.PGUSERNAME || env.PGUSER || osUsername();
  o.no_prepare && (o.prepare = false);
  query.sslmode && (query.ssl = query.sslmode, delete query.sslmode);
  "timeout" in o && (console.log("The timeout option is deprecated, use idle_timeout instead"), o.idle_timeout = o.timeout);
  query.sslrootcert === "system" && (query.ssl = "verify-full");
  const ints = ["idle_timeout", "connect_timeout", "max_lifetime", "max_pipeline", "backoff", "keep_alive"];
  const defaults = {
    max: globalThis.Cloudflare ? 3 : 10,
    ssl: false,
    sslnegotiation: null,
    idle_timeout: null,
    connect_timeout: 30,
    max_lifetime,
    max_pipeline: 100,
    backoff,
    keep_alive: 60,
    prepare: true,
    debug: false,
    fetch_types: true,
    publications: "alltables",
    target_session_attrs: null
  };
  return {
    host: Array.isArray(host) ? host : host.split(",").map((x) => x.split(":")[0]),
    port: Array.isArray(port) ? port : host.split(",").map((x) => parseInt(x.split(":")[1] || port)),
    path: o.path || host.indexOf("/") > -1 && host + "/.s.PGSQL." + port,
    database: o.database || o.db || (url.pathname || "").slice(1) || env.PGDATABASE || user,
    user,
    pass: o.pass || o.password || url.password || env.PGPASSWORD || "",
    ...Object.entries(defaults).reduce(
      (acc, [k, d]) => {
        const value = k in o ? o[k] : k in query ? query[k] === "disable" || query[k] === "false" ? false : query[k] : env["PG" + k.toUpperCase()] || d;
        acc[k] = typeof value === "string" && ints.includes(k) ? +value : value;
        return acc;
      },
      {}
    ),
    connection: {
      application_name: env.PGAPPNAME || "postgres.js",
      ...o.connection,
      ...Object.entries(query).reduce((acc, [k, v]) => (k in defaults || (acc[k] = v), acc), {})
    },
    types: o.types || {},
    target_session_attrs: tsa(o, url, env),
    onnotice: o.onnotice,
    onnotify: o.onnotify,
    onclose: o.onclose,
    onparameter: o.onparameter,
    socket: o.socket,
    transform: parseTransform(o.transform || { undefined: void 0 }),
    parameters: {},
    shared: { retries: 0, typeArrayMap: {} },
    ...mergeUserTypes(o.types)
  };
}
function tsa(o, url, env) {
  const x = o.target_session_attrs || url.searchParams.get("target_session_attrs") || env.PGTARGETSESSIONATTRS;
  if (!x || ["read-write", "read-only", "primary", "standby", "prefer-standby"].includes(x))
    return x;
  throw new Error("target_session_attrs " + x + " is not supported");
}
function backoff(retries) {
  return (0.5 + Math.random() / 2) * Math.min(3 ** retries / 100, 20);
}
function max_lifetime() {
  return 60 * (30 + Math.random() * 30);
}
function parseTransform(x) {
  return {
    undefined: x.undefined,
    column: {
      from: typeof x.column === "function" ? x.column : x.column && x.column.from,
      to: x.column && x.column.to
    },
    value: {
      from: typeof x.value === "function" ? x.value : x.value && x.value.from,
      to: x.value && x.value.to
    },
    row: {
      from: typeof x.row === "function" ? x.row : x.row && x.row.from,
      to: x.row && x.row.to
    }
  };
}
function parseUrl(url) {
  if (!url || typeof url !== "string")
    return { url: { searchParams: /* @__PURE__ */ new Map() } };
  let host = url;
  host = host.slice(host.indexOf("://") + 3).split(/[?/]/)[0];
  host = decodeURIComponent(host.slice(host.indexOf("@") + 1));
  const urlObj = new URL(url.replace(host, host.split(",")[0]));
  return {
    url: {
      username: decodeURIComponent(urlObj.username),
      password: decodeURIComponent(urlObj.password),
      host: urlObj.host,
      hostname: urlObj.hostname,
      port: urlObj.port,
      pathname: urlObj.pathname,
      searchParams: urlObj.searchParams
    },
    multihost: host.indexOf(",") > -1 && host
  };
}
function osUsername() {
  try {
    return os.userInfo().username;
  } catch (_) {
    return process.env.USERNAME || process.env.USER || process.env.LOGNAME;
  }
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/selection-proxy.js
var SelectionProxyHandler = class _SelectionProxyHandler {
  static [entityKind] = "SelectionProxyHandler";
  config;
  constructor(config) {
    this.config = { ...config };
  }
  get(subquery, prop) {
    if (prop === "_") {
      return {
        ...subquery["_"],
        selectedFields: new Proxy(
          subquery._.selectedFields,
          this
        )
      };
    }
    if (prop === ViewBaseConfig) {
      return {
        ...subquery[ViewBaseConfig],
        selectedFields: new Proxy(
          subquery[ViewBaseConfig].selectedFields,
          this
        )
      };
    }
    if (typeof prop === "symbol") {
      return subquery[prop];
    }
    const columns = is(subquery, Subquery) ? subquery._.selectedFields : is(subquery, View) ? subquery[ViewBaseConfig].selectedFields : subquery;
    const value = columns[prop];
    if (is(value, SQL.Aliased)) {
      if (this.config.sqlAliasedBehavior === "sql" && !value.isSelectionField) {
        return value.sql;
      }
      const newValue = value.clone();
      newValue.isSelectionField = true;
      return newValue;
    }
    if (is(value, SQL)) {
      if (this.config.sqlBehavior === "sql") {
        return value;
      }
      throw new Error(
        `You tried to reference "${prop}" field from a subquery, which is a raw SQL field, but it doesn't have an alias declared. Please add an alias to the field using ".as('alias')" method.`
      );
    }
    if (is(value, Column)) {
      if (this.config.alias) {
        return new Proxy(
          value,
          new ColumnAliasProxyHandler(
            new Proxy(
              value.table,
              new TableAliasProxyHandler(this.config.alias, this.config.replaceOriginalName ?? false)
            )
          )
        );
      }
      return value;
    }
    if (typeof value !== "object" || value === null) {
      return value;
    }
    return new Proxy(value, new _SelectionProxyHandler(this.config));
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/indexes.js
var IndexBuilderOn = class {
  constructor(unique2, name) {
    this.unique = unique2;
    this.name = name;
  }
  static [entityKind] = "PgIndexBuilderOn";
  on(...columns) {
    return new IndexBuilder(
      columns.map((it) => {
        if (is(it, SQL)) {
          return it;
        }
        it = it;
        const clonedIndexedColumn = new IndexedColumn(it.name, !!it.keyAsName, it.columnType, it.indexConfig);
        it.indexConfig = JSON.parse(JSON.stringify(it.defaultConfig));
        return clonedIndexedColumn;
      }),
      this.unique,
      false,
      this.name
    );
  }
  onOnly(...columns) {
    return new IndexBuilder(
      columns.map((it) => {
        if (is(it, SQL)) {
          return it;
        }
        it = it;
        const clonedIndexedColumn = new IndexedColumn(it.name, !!it.keyAsName, it.columnType, it.indexConfig);
        it.indexConfig = it.defaultConfig;
        return clonedIndexedColumn;
      }),
      this.unique,
      true,
      this.name
    );
  }
  /**
   * Specify what index method to use. Choices are `btree`, `hash`, `gist`, `spgist`, `gin`, `brin`, or user-installed access methods like `bloom`. The default method is `btree.
   *
   * If you have the `pg_vector` extension installed in your database, you can use the `hnsw` and `ivfflat` options, which are predefined types.
   *
   * **You can always specify any string you want in the method, in case Drizzle doesn't have it natively in its types**
   *
   * @param method The name of the index method to be used
   * @param columns
   * @returns
   */
  using(method, ...columns) {
    return new IndexBuilder(
      columns.map((it) => {
        if (is(it, SQL)) {
          return it;
        }
        it = it;
        const clonedIndexedColumn = new IndexedColumn(it.name, !!it.keyAsName, it.columnType, it.indexConfig);
        it.indexConfig = JSON.parse(JSON.stringify(it.defaultConfig));
        return clonedIndexedColumn;
      }),
      this.unique,
      true,
      this.name,
      method
    );
  }
};
var IndexBuilder = class {
  static [entityKind] = "PgIndexBuilder";
  /** @internal */
  config;
  constructor(columns, unique2, only, name, method = "btree") {
    this.config = {
      name,
      columns,
      unique: unique2,
      only,
      method
    };
  }
  concurrently() {
    this.config.concurrently = true;
    return this;
  }
  with(obj) {
    this.config.with = obj;
    return this;
  }
  where(condition) {
    this.config.where = condition;
    return this;
  }
  /** @internal */
  build(table) {
    return new Index(this.config, table);
  }
};
var Index = class {
  static [entityKind] = "PgIndex";
  config;
  constructor(config, table) {
    this.config = { ...config, table };
  }
};
function index(name) {
  return new IndexBuilderOn(false, name);
}
function uniqueIndex(name) {
  return new IndexBuilderOn(true, name);
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/casing.js
function toSnakeCase(input) {
  const words = input.replace(/['\u2019]/g, "").match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g) ?? [];
  return words.map((word) => word.toLowerCase()).join("_");
}
function toCamelCase(input) {
  const words = input.replace(/['\u2019]/g, "").match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g) ?? [];
  return words.reduce((acc, word, i) => {
    const formattedWord = i === 0 ? word.toLowerCase() : `${word[0].toUpperCase()}${word.slice(1)}`;
    return acc + formattedWord;
  }, "");
}
function noopCase(input) {
  return input;
}
var CasingCache = class {
  static [entityKind] = "CasingCache";
  /** @internal */
  cache = {};
  cachedTables = {};
  convert;
  constructor(casing) {
    this.convert = casing === "snake_case" ? toSnakeCase : casing === "camelCase" ? toCamelCase : noopCase;
  }
  getColumnCasing(column) {
    if (!column.keyAsName) return column.name;
    const schema = column.table[Table.Symbol.Schema] ?? "public";
    const tableName = column.table[Table.Symbol.OriginalName];
    const key = `${schema}.${tableName}.${column.name}`;
    if (!this.cache[key]) {
      this.cacheTable(column.table);
    }
    return this.cache[key];
  }
  cacheTable(table) {
    const schema = table[Table.Symbol.Schema] ?? "public";
    const tableName = table[Table.Symbol.OriginalName];
    const tableKey = `${schema}.${tableName}`;
    if (!this.cachedTables[tableKey]) {
      for (const column of Object.values(table[Table.Symbol.Columns])) {
        const columnKey = `${tableKey}.${column.name}`;
        this.cache[columnKey] = this.convert(column.name);
      }
      this.cachedTables[tableKey] = true;
    }
  }
  clearCache() {
    this.cache = {};
    this.cachedTables = {};
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/view-base.js
var PgViewBase = class extends View {
  static [entityKind] = "PgViewBase";
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/dialect.js
var PgDialect = class {
  static [entityKind] = "PgDialect";
  /** @internal */
  casing;
  constructor(config) {
    this.casing = new CasingCache(config?.casing);
  }
  async migrate(migrations, session, config) {
    const migrationsTable = typeof config === "string" ? "__drizzle_migrations" : config.migrationsTable ?? "__drizzle_migrations";
    const migrationsSchema = typeof config === "string" ? "drizzle" : config.migrationsSchema ?? "drizzle";
    const migrationTableCreate = sql`
			CREATE TABLE IF NOT EXISTS ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)} (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at bigint
			)
		`;
    await session.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(migrationsSchema)}`);
    await session.execute(migrationTableCreate);
    const dbMigrations = await session.all(
      sql`select id, hash, created_at from ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)} order by created_at desc limit 1`
    );
    const lastDbMigration = dbMigrations[0];
    await session.transaction(async (tx) => {
      for await (const migration of migrations) {
        if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) {
          for (const stmt of migration.sql) {
            await tx.execute(sql.raw(stmt));
          }
          await tx.execute(
            sql`insert into ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)} ("hash", "created_at") values(${migration.hash}, ${migration.folderMillis})`
          );
        }
      }
    });
  }
  escapeName(name) {
    return `"${name}"`;
  }
  escapeParam(num) {
    return `$${num + 1}`;
  }
  escapeString(str) {
    return `'${str.replace(/'/g, "''")}'`;
  }
  buildWithCTE(queries) {
    if (!queries?.length) return void 0;
    const withSqlChunks = [sql`with `];
    for (const [i, w] of queries.entries()) {
      withSqlChunks.push(sql`${sql.identifier(w._.alias)} as (${w._.sql})`);
      if (i < queries.length - 1) {
        withSqlChunks.push(sql`, `);
      }
    }
    withSqlChunks.push(sql` `);
    return sql.join(withSqlChunks);
  }
  buildDeleteQuery({ table, where, returning, withList }) {
    const withSql = this.buildWithCTE(withList);
    const returningSql = returning ? sql` returning ${this.buildSelection(returning, { isSingleTable: true })}` : void 0;
    const whereSql = where ? sql` where ${where}` : void 0;
    return sql`${withSql}delete from ${table}${whereSql}${returningSql}`;
  }
  buildUpdateSet(table, set) {
    const tableColumns = table[Table.Symbol.Columns];
    const columnNames = Object.keys(tableColumns).filter(
      (colName) => set[colName] !== void 0 || tableColumns[colName]?.onUpdateFn !== void 0
    );
    const setSize = columnNames.length;
    return sql.join(columnNames.flatMap((colName, i) => {
      const col = tableColumns[colName];
      const value = set[colName] ?? sql.param(col.onUpdateFn(), col);
      const res = sql`${sql.identifier(this.casing.getColumnCasing(col))} = ${value}`;
      if (i < setSize - 1) {
        return [res, sql.raw(", ")];
      }
      return [res];
    }));
  }
  buildUpdateQuery({ table, set, where, returning, withList, from, joins }) {
    const withSql = this.buildWithCTE(withList);
    const tableName = table[PgTable.Symbol.Name];
    const tableSchema = table[PgTable.Symbol.Schema];
    const origTableName = table[PgTable.Symbol.OriginalName];
    const alias = tableName === origTableName ? void 0 : tableName;
    const tableSql = sql`${tableSchema ? sql`${sql.identifier(tableSchema)}.` : void 0}${sql.identifier(origTableName)}${alias && sql` ${sql.identifier(alias)}`}`;
    const setSql = this.buildUpdateSet(table, set);
    const fromSql = from && sql.join([sql.raw(" from "), this.buildFromTable(from)]);
    const joinsSql = this.buildJoins(joins);
    const returningSql = returning ? sql` returning ${this.buildSelection(returning, { isSingleTable: !from })}` : void 0;
    const whereSql = where ? sql` where ${where}` : void 0;
    return sql`${withSql}update ${tableSql} set ${setSql}${fromSql}${joinsSql}${whereSql}${returningSql}`;
  }
  /**
   * Builds selection SQL with provided fields/expressions
   *
   * Examples:
   *
   * `select <selection> from`
   *
   * `insert ... returning <selection>`
   *
   * If `isSingleTable` is true, then columns won't be prefixed with table name
   */
  buildSelection(fields, { isSingleTable = false } = {}) {
    const columnsLen = fields.length;
    const chunks = fields.flatMap(({ field }, i) => {
      const chunk = [];
      if (is(field, SQL.Aliased) && field.isSelectionField) {
        chunk.push(sql.identifier(field.fieldAlias));
      } else if (is(field, SQL.Aliased) || is(field, SQL)) {
        const query = is(field, SQL.Aliased) ? field.sql : field;
        if (isSingleTable) {
          chunk.push(
            new SQL(
              query.queryChunks.map((c) => {
                if (is(c, PgColumn)) {
                  return sql.identifier(this.casing.getColumnCasing(c));
                }
                return c;
              })
            )
          );
        } else {
          chunk.push(query);
        }
        if (is(field, SQL.Aliased)) {
          chunk.push(sql` as ${sql.identifier(field.fieldAlias)}`);
        }
      } else if (is(field, Column)) {
        if (isSingleTable) {
          chunk.push(sql.identifier(this.casing.getColumnCasing(field)));
        } else {
          chunk.push(field);
        }
      }
      if (i < columnsLen - 1) {
        chunk.push(sql`, `);
      }
      return chunk;
    });
    return sql.join(chunks);
  }
  buildJoins(joins) {
    if (!joins || joins.length === 0) {
      return void 0;
    }
    const joinsArray = [];
    for (const [index2, joinMeta] of joins.entries()) {
      if (index2 === 0) {
        joinsArray.push(sql` `);
      }
      const table = joinMeta.table;
      const lateralSql = joinMeta.lateral ? sql` lateral` : void 0;
      const onSql = joinMeta.on ? sql` on ${joinMeta.on}` : void 0;
      if (is(table, PgTable)) {
        const tableName = table[PgTable.Symbol.Name];
        const tableSchema = table[PgTable.Symbol.Schema];
        const origTableName = table[PgTable.Symbol.OriginalName];
        const alias = tableName === origTableName ? void 0 : joinMeta.alias;
        joinsArray.push(
          sql`${sql.raw(joinMeta.joinType)} join${lateralSql} ${tableSchema ? sql`${sql.identifier(tableSchema)}.` : void 0}${sql.identifier(origTableName)}${alias && sql` ${sql.identifier(alias)}`}${onSql}`
        );
      } else if (is(table, View)) {
        const viewName = table[ViewBaseConfig].name;
        const viewSchema = table[ViewBaseConfig].schema;
        const origViewName = table[ViewBaseConfig].originalName;
        const alias = viewName === origViewName ? void 0 : joinMeta.alias;
        joinsArray.push(
          sql`${sql.raw(joinMeta.joinType)} join${lateralSql} ${viewSchema ? sql`${sql.identifier(viewSchema)}.` : void 0}${sql.identifier(origViewName)}${alias && sql` ${sql.identifier(alias)}`}${onSql}`
        );
      } else {
        joinsArray.push(
          sql`${sql.raw(joinMeta.joinType)} join${lateralSql} ${table}${onSql}`
        );
      }
      if (index2 < joins.length - 1) {
        joinsArray.push(sql` `);
      }
    }
    return sql.join(joinsArray);
  }
  buildFromTable(table) {
    if (is(table, Table) && table[Table.Symbol.IsAlias]) {
      let fullName = sql`${sql.identifier(table[Table.Symbol.OriginalName])}`;
      if (table[Table.Symbol.Schema]) {
        fullName = sql`${sql.identifier(table[Table.Symbol.Schema])}.${fullName}`;
      }
      return sql`${fullName} ${sql.identifier(table[Table.Symbol.Name])}`;
    }
    return table;
  }
  buildSelectQuery({
    withList,
    fields,
    fieldsFlat,
    where,
    having,
    table,
    joins,
    orderBy,
    groupBy,
    limit,
    offset,
    lockingClause,
    distinct,
    setOperators
  }) {
    const fieldsList = fieldsFlat ?? orderSelectedFields(fields);
    for (const f of fieldsList) {
      if (is(f.field, Column) && getTableName(f.field.table) !== (is(table, Subquery) ? table._.alias : is(table, PgViewBase) ? table[ViewBaseConfig].name : is(table, SQL) ? void 0 : getTableName(table)) && !((table2) => joins?.some(
        ({ alias }) => alias === (table2[Table.Symbol.IsAlias] ? getTableName(table2) : table2[Table.Symbol.BaseName])
      ))(f.field.table)) {
        const tableName = getTableName(f.field.table);
        throw new Error(
          `Your "${f.path.join("->")}" field references a column "${tableName}"."${f.field.name}", but the table "${tableName}" is not part of the query! Did you forget to join it?`
        );
      }
    }
    const isSingleTable = !joins || joins.length === 0;
    const withSql = this.buildWithCTE(withList);
    let distinctSql;
    if (distinct) {
      distinctSql = distinct === true ? sql` distinct` : sql` distinct on (${sql.join(distinct.on, sql`, `)})`;
    }
    const selection = this.buildSelection(fieldsList, { isSingleTable });
    const tableSql = this.buildFromTable(table);
    const joinsSql = this.buildJoins(joins);
    const whereSql = where ? sql` where ${where}` : void 0;
    const havingSql = having ? sql` having ${having}` : void 0;
    let orderBySql;
    if (orderBy && orderBy.length > 0) {
      orderBySql = sql` order by ${sql.join(orderBy, sql`, `)}`;
    }
    let groupBySql;
    if (groupBy && groupBy.length > 0) {
      groupBySql = sql` group by ${sql.join(groupBy, sql`, `)}`;
    }
    const limitSql = typeof limit === "object" || typeof limit === "number" && limit >= 0 ? sql` limit ${limit}` : void 0;
    const offsetSql = offset ? sql` offset ${offset}` : void 0;
    const lockingClauseSql = sql.empty();
    if (lockingClause) {
      const clauseSql = sql` for ${sql.raw(lockingClause.strength)}`;
      if (lockingClause.config.of) {
        clauseSql.append(
          sql` of ${sql.join(
            Array.isArray(lockingClause.config.of) ? lockingClause.config.of : [lockingClause.config.of],
            sql`, `
          )}`
        );
      }
      if (lockingClause.config.noWait) {
        clauseSql.append(sql` nowait`);
      } else if (lockingClause.config.skipLocked) {
        clauseSql.append(sql` skip locked`);
      }
      lockingClauseSql.append(clauseSql);
    }
    const finalQuery = sql`${withSql}select${distinctSql} ${selection} from ${tableSql}${joinsSql}${whereSql}${groupBySql}${havingSql}${orderBySql}${limitSql}${offsetSql}${lockingClauseSql}`;
    if (setOperators.length > 0) {
      return this.buildSetOperations(finalQuery, setOperators);
    }
    return finalQuery;
  }
  buildSetOperations(leftSelect, setOperators) {
    const [setOperator, ...rest] = setOperators;
    if (!setOperator) {
      throw new Error("Cannot pass undefined values to any set operator");
    }
    if (rest.length === 0) {
      return this.buildSetOperationQuery({ leftSelect, setOperator });
    }
    return this.buildSetOperations(
      this.buildSetOperationQuery({ leftSelect, setOperator }),
      rest
    );
  }
  buildSetOperationQuery({
    leftSelect,
    setOperator: { type, isAll, rightSelect, limit, orderBy, offset }
  }) {
    const leftChunk = sql`(${leftSelect.getSQL()}) `;
    const rightChunk = sql`(${rightSelect.getSQL()})`;
    let orderBySql;
    if (orderBy && orderBy.length > 0) {
      const orderByValues = [];
      for (const singleOrderBy of orderBy) {
        if (is(singleOrderBy, PgColumn)) {
          orderByValues.push(sql.identifier(singleOrderBy.name));
        } else if (is(singleOrderBy, SQL)) {
          for (let i = 0; i < singleOrderBy.queryChunks.length; i++) {
            const chunk = singleOrderBy.queryChunks[i];
            if (is(chunk, PgColumn)) {
              singleOrderBy.queryChunks[i] = sql.identifier(chunk.name);
            }
          }
          orderByValues.push(sql`${singleOrderBy}`);
        } else {
          orderByValues.push(sql`${singleOrderBy}`);
        }
      }
      orderBySql = sql` order by ${sql.join(orderByValues, sql`, `)} `;
    }
    const limitSql = typeof limit === "object" || typeof limit === "number" && limit >= 0 ? sql` limit ${limit}` : void 0;
    const operatorChunk = sql.raw(`${type} ${isAll ? "all " : ""}`);
    const offsetSql = offset ? sql` offset ${offset}` : void 0;
    return sql`${leftChunk}${operatorChunk}${rightChunk}${orderBySql}${limitSql}${offsetSql}`;
  }
  buildInsertQuery({ table, values: valuesOrSelect, onConflict, returning, withList, select: select2, overridingSystemValue_ }) {
    const valuesSqlList = [];
    const columns = table[Table.Symbol.Columns];
    const colEntries = Object.entries(columns).filter(([_, col]) => !col.shouldDisableInsert());
    const insertOrder = colEntries.map(
      ([, column]) => sql.identifier(this.casing.getColumnCasing(column))
    );
    if (select2) {
      const select22 = valuesOrSelect;
      if (is(select22, SQL)) {
        valuesSqlList.push(select22);
      } else {
        valuesSqlList.push(select22.getSQL());
      }
    } else {
      const values2 = valuesOrSelect;
      valuesSqlList.push(sql.raw("values "));
      for (const [valueIndex, value] of values2.entries()) {
        const valueList = [];
        for (const [fieldName, col] of colEntries) {
          const colValue = value[fieldName];
          if (colValue === void 0 || is(colValue, Param) && colValue.value === void 0) {
            if (col.defaultFn !== void 0) {
              const defaultFnResult = col.defaultFn();
              const defaultValue = is(defaultFnResult, SQL) ? defaultFnResult : sql.param(defaultFnResult, col);
              valueList.push(defaultValue);
            } else if (!col.default && col.onUpdateFn !== void 0) {
              const onUpdateFnResult = col.onUpdateFn();
              const newValue = is(onUpdateFnResult, SQL) ? onUpdateFnResult : sql.param(onUpdateFnResult, col);
              valueList.push(newValue);
            } else {
              valueList.push(sql`default`);
            }
          } else {
            valueList.push(colValue);
          }
        }
        valuesSqlList.push(valueList);
        if (valueIndex < values2.length - 1) {
          valuesSqlList.push(sql`, `);
        }
      }
    }
    const withSql = this.buildWithCTE(withList);
    const valuesSql = sql.join(valuesSqlList);
    const returningSql = returning ? sql` returning ${this.buildSelection(returning, { isSingleTable: true })}` : void 0;
    const onConflictSql = onConflict ? sql` on conflict ${onConflict}` : void 0;
    const overridingSql = overridingSystemValue_ === true ? sql`overriding system value ` : void 0;
    return sql`${withSql}insert into ${table} ${insertOrder} ${overridingSql}${valuesSql}${onConflictSql}${returningSql}`;
  }
  buildRefreshMaterializedViewQuery({ view, concurrently, withNoData }) {
    const concurrentlySql = concurrently ? sql` concurrently` : void 0;
    const withNoDataSql = withNoData ? sql` with no data` : void 0;
    return sql`refresh materialized view${concurrentlySql} ${view}${withNoDataSql}`;
  }
  prepareTyping(encoder) {
    if (is(encoder, PgJsonb) || is(encoder, PgJson)) {
      return "json";
    } else if (is(encoder, PgNumeric)) {
      return "decimal";
    } else if (is(encoder, PgTime)) {
      return "time";
    } else if (is(encoder, PgTimestamp) || is(encoder, PgTimestampString)) {
      return "timestamp";
    } else if (is(encoder, PgDate) || is(encoder, PgDateString)) {
      return "date";
    } else if (is(encoder, PgUUID)) {
      return "uuid";
    } else {
      return "none";
    }
  }
  sqlToQuery(sql2, invokeSource) {
    return sql2.toQuery({
      casing: this.casing,
      escapeName: this.escapeName,
      escapeParam: this.escapeParam,
      escapeString: this.escapeString,
      prepareTyping: this.prepareTyping,
      invokeSource
    });
  }
  // buildRelationalQueryWithPK({
  // 	fullSchema,
  // 	schema,
  // 	tableNamesMap,
  // 	table,
  // 	tableConfig,
  // 	queryConfig: config,
  // 	tableAlias,
  // 	isRoot = false,
  // 	joinOn,
  // }: {
  // 	fullSchema: Record<string, unknown>;
  // 	schema: TablesRelationalConfig;
  // 	tableNamesMap: Record<string, string>;
  // 	table: PgTable;
  // 	tableConfig: TableRelationalConfig;
  // 	queryConfig: true | DBQueryConfig<'many', true>;
  // 	tableAlias: string;
  // 	isRoot?: boolean;
  // 	joinOn?: SQL;
  // }): BuildRelationalQueryResult<PgTable, PgColumn> {
  // 	// For { "<relation>": true }, return a table with selection of all columns
  // 	if (config === true) {
  // 		const selectionEntries = Object.entries(tableConfig.columns);
  // 		const selection: BuildRelationalQueryResult<PgTable, PgColumn>['selection'] = selectionEntries.map((
  // 			[key, value],
  // 		) => ({
  // 			dbKey: value.name,
  // 			tsKey: key,
  // 			field: value as PgColumn,
  // 			relationTableTsKey: undefined,
  // 			isJson: false,
  // 			selection: [],
  // 		}));
  // 		return {
  // 			tableTsKey: tableConfig.tsName,
  // 			sql: table,
  // 			selection,
  // 		};
  // 	}
  // 	// let selection: BuildRelationalQueryResult<PgTable, PgColumn>['selection'] = [];
  // 	// let selectionForBuild = selection;
  // 	const aliasedColumns = Object.fromEntries(
  // 		Object.entries(tableConfig.columns).map(([key, value]) => [key, aliasedTableColumn(value, tableAlias)]),
  // 	);
  // 	const aliasedRelations = Object.fromEntries(
  // 		Object.entries(tableConfig.relations).map(([key, value]) => [key, aliasedRelation(value, tableAlias)]),
  // 	);
  // 	const aliasedFields = Object.assign({}, aliasedColumns, aliasedRelations);
  // 	let where, hasUserDefinedWhere;
  // 	if (config.where) {
  // 		const whereSql = typeof config.where === 'function' ? config.where(aliasedFields, operators) : config.where;
  // 		where = whereSql && mapColumnsInSQLToAlias(whereSql, tableAlias);
  // 		hasUserDefinedWhere = !!where;
  // 	}
  // 	where = and(joinOn, where);
  // 	// const fieldsSelection: { tsKey: string; value: PgColumn | SQL.Aliased; isExtra?: boolean }[] = [];
  // 	let joins: Join[] = [];
  // 	let selectedColumns: string[] = [];
  // 	// Figure out which columns to select
  // 	if (config.columns) {
  // 		let isIncludeMode = false;
  // 		for (const [field, value] of Object.entries(config.columns)) {
  // 			if (value === undefined) {
  // 				continue;
  // 			}
  // 			if (field in tableConfig.columns) {
  // 				if (!isIncludeMode && value === true) {
  // 					isIncludeMode = true;
  // 				}
  // 				selectedColumns.push(field);
  // 			}
  // 		}
  // 		if (selectedColumns.length > 0) {
  // 			selectedColumns = isIncludeMode
  // 				? selectedColumns.filter((c) => config.columns?.[c] === true)
  // 				: Object.keys(tableConfig.columns).filter((key) => !selectedColumns.includes(key));
  // 		}
  // 	} else {
  // 		// Select all columns if selection is not specified
  // 		selectedColumns = Object.keys(tableConfig.columns);
  // 	}
  // 	// for (const field of selectedColumns) {
  // 	// 	const column = tableConfig.columns[field]! as PgColumn;
  // 	// 	fieldsSelection.push({ tsKey: field, value: column });
  // 	// }
  // 	let initiallySelectedRelations: {
  // 		tsKey: string;
  // 		queryConfig: true | DBQueryConfig<'many', false>;
  // 		relation: Relation;
  // 	}[] = [];
  // 	// let selectedRelations: BuildRelationalQueryResult<PgTable, PgColumn>['selection'] = [];
  // 	// Figure out which relations to select
  // 	if (config.with) {
  // 		initiallySelectedRelations = Object.entries(config.with)
  // 			.filter((entry): entry is [typeof entry[0], NonNullable<typeof entry[1]>] => !!entry[1])
  // 			.map(([tsKey, queryConfig]) => ({ tsKey, queryConfig, relation: tableConfig.relations[tsKey]! }));
  // 	}
  // 	const manyRelations = initiallySelectedRelations.filter((r) =>
  // 		is(r.relation, Many)
  // 		&& (schema[tableNamesMap[r.relation.referencedTable[Table.Symbol.Name]]!]?.primaryKey.length ?? 0) > 0
  // 	);
  // 	// If this is the last Many relation (or there are no Many relations), we are on the innermost subquery level
  // 	const isInnermostQuery = manyRelations.length < 2;
  // 	const selectedExtras: {
  // 		tsKey: string;
  // 		value: SQL.Aliased;
  // 	}[] = [];
  // 	// Figure out which extras to select
  // 	if (isInnermostQuery && config.extras) {
  // 		const extras = typeof config.extras === 'function'
  // 			? config.extras(aliasedFields, { sql })
  // 			: config.extras;
  // 		for (const [tsKey, value] of Object.entries(extras)) {
  // 			selectedExtras.push({
  // 				tsKey,
  // 				value: mapColumnsInAliasedSQLToAlias(value, tableAlias),
  // 			});
  // 		}
  // 	}
  // 	// Transform `fieldsSelection` into `selection`
  // 	// `fieldsSelection` shouldn't be used after this point
  // 	// for (const { tsKey, value, isExtra } of fieldsSelection) {
  // 	// 	selection.push({
  // 	// 		dbKey: is(value, SQL.Aliased) ? value.fieldAlias : tableConfig.columns[tsKey]!.name,
  // 	// 		tsKey,
  // 	// 		field: is(value, Column) ? aliasedTableColumn(value, tableAlias) : value,
  // 	// 		relationTableTsKey: undefined,
  // 	// 		isJson: false,
  // 	// 		isExtra,
  // 	// 		selection: [],
  // 	// 	});
  // 	// }
  // 	let orderByOrig = typeof config.orderBy === 'function'
  // 		? config.orderBy(aliasedFields, orderByOperators)
  // 		: config.orderBy ?? [];
  // 	if (!Array.isArray(orderByOrig)) {
  // 		orderByOrig = [orderByOrig];
  // 	}
  // 	const orderBy = orderByOrig.map((orderByValue) => {
  // 		if (is(orderByValue, Column)) {
  // 			return aliasedTableColumn(orderByValue, tableAlias) as PgColumn;
  // 		}
  // 		return mapColumnsInSQLToAlias(orderByValue, tableAlias);
  // 	});
  // 	const limit = isInnermostQuery ? config.limit : undefined;
  // 	const offset = isInnermostQuery ? config.offset : undefined;
  // 	// For non-root queries without additional config except columns, return a table with selection
  // 	if (
  // 		!isRoot
  // 		&& initiallySelectedRelations.length === 0
  // 		&& selectedExtras.length === 0
  // 		&& !where
  // 		&& orderBy.length === 0
  // 		&& limit === undefined
  // 		&& offset === undefined
  // 	) {
  // 		return {
  // 			tableTsKey: tableConfig.tsName,
  // 			sql: table,
  // 			selection: selectedColumns.map((key) => ({
  // 				dbKey: tableConfig.columns[key]!.name,
  // 				tsKey: key,
  // 				field: tableConfig.columns[key] as PgColumn,
  // 				relationTableTsKey: undefined,
  // 				isJson: false,
  // 				selection: [],
  // 			})),
  // 		};
  // 	}
  // 	const selectedRelationsWithoutPK:
  // 	// Process all relations without primary keys, because they need to be joined differently and will all be on the same query level
  // 	for (
  // 		const {
  // 			tsKey: selectedRelationTsKey,
  // 			queryConfig: selectedRelationConfigValue,
  // 			relation,
  // 		} of initiallySelectedRelations
  // 	) {
  // 		const normalizedRelation = normalizeRelation(schema, tableNamesMap, relation);
  // 		const relationTableName = relation.referencedTable[Table.Symbol.Name];
  // 		const relationTableTsName = tableNamesMap[relationTableName]!;
  // 		const relationTable = schema[relationTableTsName]!;
  // 		if (relationTable.primaryKey.length > 0) {
  // 			continue;
  // 		}
  // 		const relationTableAlias = `${tableAlias}_${selectedRelationTsKey}`;
  // 		const joinOn = and(
  // 			...normalizedRelation.fields.map((field, i) =>
  // 				eq(
  // 					aliasedTableColumn(normalizedRelation.references[i]!, relationTableAlias),
  // 					aliasedTableColumn(field, tableAlias),
  // 				)
  // 			),
  // 		);
  // 		const builtRelation = this.buildRelationalQueryWithoutPK({
  // 			fullSchema,
  // 			schema,
  // 			tableNamesMap,
  // 			table: fullSchema[relationTableTsName] as PgTable,
  // 			tableConfig: schema[relationTableTsName]!,
  // 			queryConfig: selectedRelationConfigValue,
  // 			tableAlias: relationTableAlias,
  // 			joinOn,
  // 			nestedQueryRelation: relation,
  // 		});
  // 		const field = sql`${sql.identifier(relationTableAlias)}.${sql.identifier('data')}`.as(selectedRelationTsKey);
  // 		joins.push({
  // 			on: sql`true`,
  // 			table: new Subquery(builtRelation.sql as SQL, {}, relationTableAlias),
  // 			alias: relationTableAlias,
  // 			joinType: 'left',
  // 			lateral: true,
  // 		});
  // 		selectedRelations.push({
  // 			dbKey: selectedRelationTsKey,
  // 			tsKey: selectedRelationTsKey,
  // 			field,
  // 			relationTableTsKey: relationTableTsName,
  // 			isJson: true,
  // 			selection: builtRelation.selection,
  // 		});
  // 	}
  // 	const oneRelations = initiallySelectedRelations.filter((r): r is typeof r & { relation: One } =>
  // 		is(r.relation, One)
  // 	);
  // 	// Process all One relations with PKs, because they can all be joined on the same level
  // 	for (
  // 		const {
  // 			tsKey: selectedRelationTsKey,
  // 			queryConfig: selectedRelationConfigValue,
  // 			relation,
  // 		} of oneRelations
  // 	) {
  // 		const normalizedRelation = normalizeRelation(schema, tableNamesMap, relation);
  // 		const relationTableName = relation.referencedTable[Table.Symbol.Name];
  // 		const relationTableTsName = tableNamesMap[relationTableName]!;
  // 		const relationTableAlias = `${tableAlias}_${selectedRelationTsKey}`;
  // 		const relationTable = schema[relationTableTsName]!;
  // 		if (relationTable.primaryKey.length === 0) {
  // 			continue;
  // 		}
  // 		const joinOn = and(
  // 			...normalizedRelation.fields.map((field, i) =>
  // 				eq(
  // 					aliasedTableColumn(normalizedRelation.references[i]!, relationTableAlias),
  // 					aliasedTableColumn(field, tableAlias),
  // 				)
  // 			),
  // 		);
  // 		const builtRelation = this.buildRelationalQueryWithPK({
  // 			fullSchema,
  // 			schema,
  // 			tableNamesMap,
  // 			table: fullSchema[relationTableTsName] as PgTable,
  // 			tableConfig: schema[relationTableTsName]!,
  // 			queryConfig: selectedRelationConfigValue,
  // 			tableAlias: relationTableAlias,
  // 			joinOn,
  // 		});
  // 		const field = sql`case when ${sql.identifier(relationTableAlias)} is null then null else json_build_array(${
  // 			sql.join(
  // 				builtRelation.selection.map(({ field }) =>
  // 					is(field, SQL.Aliased)
  // 						? sql`${sql.identifier(relationTableAlias)}.${sql.identifier(field.fieldAlias)}`
  // 						: is(field, Column)
  // 						? aliasedTableColumn(field, relationTableAlias)
  // 						: field
  // 				),
  // 				sql`, `,
  // 			)
  // 		}) end`.as(selectedRelationTsKey);
  // 		const isLateralJoin = is(builtRelation.sql, SQL);
  // 		joins.push({
  // 			on: isLateralJoin ? sql`true` : joinOn,
  // 			table: is(builtRelation.sql, SQL)
  // 				? new Subquery(builtRelation.sql, {}, relationTableAlias)
  // 				: aliasedTable(builtRelation.sql, relationTableAlias),
  // 			alias: relationTableAlias,
  // 			joinType: 'left',
  // 			lateral: is(builtRelation.sql, SQL),
  // 		});
  // 		selectedRelations.push({
  // 			dbKey: selectedRelationTsKey,
  // 			tsKey: selectedRelationTsKey,
  // 			field,
  // 			relationTableTsKey: relationTableTsName,
  // 			isJson: true,
  // 			selection: builtRelation.selection,
  // 		});
  // 	}
  // 	let distinct: PgSelectConfig['distinct'];
  // 	let tableFrom: PgTable | Subquery = table;
  // 	// Process first Many relation - each one requires a nested subquery
  // 	const manyRelation = manyRelations[0];
  // 	if (manyRelation) {
  // 		const {
  // 			tsKey: selectedRelationTsKey,
  // 			queryConfig: selectedRelationQueryConfig,
  // 			relation,
  // 		} = manyRelation;
  // 		distinct = {
  // 			on: tableConfig.primaryKey.map((c) => aliasedTableColumn(c as PgColumn, tableAlias)),
  // 		};
  // 		const normalizedRelation = normalizeRelation(schema, tableNamesMap, relation);
  // 		const relationTableName = relation.referencedTable[Table.Symbol.Name];
  // 		const relationTableTsName = tableNamesMap[relationTableName]!;
  // 		const relationTableAlias = `${tableAlias}_${selectedRelationTsKey}`;
  // 		const joinOn = and(
  // 			...normalizedRelation.fields.map((field, i) =>
  // 				eq(
  // 					aliasedTableColumn(normalizedRelation.references[i]!, relationTableAlias),
  // 					aliasedTableColumn(field, tableAlias),
  // 				)
  // 			),
  // 		);
  // 		const builtRelationJoin = this.buildRelationalQueryWithPK({
  // 			fullSchema,
  // 			schema,
  // 			tableNamesMap,
  // 			table: fullSchema[relationTableTsName] as PgTable,
  // 			tableConfig: schema[relationTableTsName]!,
  // 			queryConfig: selectedRelationQueryConfig,
  // 			tableAlias: relationTableAlias,
  // 			joinOn,
  // 		});
  // 		const builtRelationSelectionField = sql`case when ${
  // 			sql.identifier(relationTableAlias)
  // 		} is null then '[]' else json_agg(json_build_array(${
  // 			sql.join(
  // 				builtRelationJoin.selection.map(({ field }) =>
  // 					is(field, SQL.Aliased)
  // 						? sql`${sql.identifier(relationTableAlias)}.${sql.identifier(field.fieldAlias)}`
  // 						: is(field, Column)
  // 						? aliasedTableColumn(field, relationTableAlias)
  // 						: field
  // 				),
  // 				sql`, `,
  // 			)
  // 		})) over (partition by ${sql.join(distinct.on, sql`, `)}) end`.as(selectedRelationTsKey);
  // 		const isLateralJoin = is(builtRelationJoin.sql, SQL);
  // 		joins.push({
  // 			on: isLateralJoin ? sql`true` : joinOn,
  // 			table: isLateralJoin
  // 				? new Subquery(builtRelationJoin.sql as SQL, {}, relationTableAlias)
  // 				: aliasedTable(builtRelationJoin.sql as PgTable, relationTableAlias),
  // 			alias: relationTableAlias,
  // 			joinType: 'left',
  // 			lateral: isLateralJoin,
  // 		});
  // 		// Build the "from" subquery with the remaining Many relations
  // 		const builtTableFrom = this.buildRelationalQueryWithPK({
  // 			fullSchema,
  // 			schema,
  // 			tableNamesMap,
  // 			table,
  // 			tableConfig,
  // 			queryConfig: {
  // 				...config,
  // 				where: undefined,
  // 				orderBy: undefined,
  // 				limit: undefined,
  // 				offset: undefined,
  // 				with: manyRelations.slice(1).reduce<NonNullable<typeof config['with']>>(
  // 					(result, { tsKey, queryConfig: configValue }) => {
  // 						result[tsKey] = configValue;
  // 						return result;
  // 					},
  // 					{},
  // 				),
  // 			},
  // 			tableAlias,
  // 		});
  // 		selectedRelations.push({
  // 			dbKey: selectedRelationTsKey,
  // 			tsKey: selectedRelationTsKey,
  // 			field: builtRelationSelectionField,
  // 			relationTableTsKey: relationTableTsName,
  // 			isJson: true,
  // 			selection: builtRelationJoin.selection,
  // 		});
  // 		// selection = builtTableFrom.selection.map((item) =>
  // 		// 	is(item.field, SQL.Aliased)
  // 		// 		? { ...item, field: sql`${sql.identifier(tableAlias)}.${sql.identifier(item.field.fieldAlias)}` }
  // 		// 		: item
  // 		// );
  // 		// selectionForBuild = [{
  // 		// 	dbKey: '*',
  // 		// 	tsKey: '*',
  // 		// 	field: sql`${sql.identifier(tableAlias)}.*`,
  // 		// 	selection: [],
  // 		// 	isJson: false,
  // 		// 	relationTableTsKey: undefined,
  // 		// }];
  // 		// const newSelectionItem: (typeof selection)[number] = {
  // 		// 	dbKey: selectedRelationTsKey,
  // 		// 	tsKey: selectedRelationTsKey,
  // 		// 	field,
  // 		// 	relationTableTsKey: relationTableTsName,
  // 		// 	isJson: true,
  // 		// 	selection: builtRelationJoin.selection,
  // 		// };
  // 		// selection.push(newSelectionItem);
  // 		// selectionForBuild.push(newSelectionItem);
  // 		tableFrom = is(builtTableFrom.sql, PgTable)
  // 			? builtTableFrom.sql
  // 			: new Subquery(builtTableFrom.sql, {}, tableAlias);
  // 	}
  // 	if (selectedColumns.length === 0 && selectedRelations.length === 0 && selectedExtras.length === 0) {
  // 		throw new DrizzleError(`No fields selected for table "${tableConfig.tsName}" ("${tableAlias}")`);
  // 	}
  // 	let selection: BuildRelationalQueryResult<PgTable, PgColumn>['selection'];
  // 	function prepareSelectedColumns() {
  // 		return selectedColumns.map((key) => ({
  // 			dbKey: tableConfig.columns[key]!.name,
  // 			tsKey: key,
  // 			field: tableConfig.columns[key] as PgColumn,
  // 			relationTableTsKey: undefined,
  // 			isJson: false,
  // 			selection: [],
  // 		}));
  // 	}
  // 	function prepareSelectedExtras() {
  // 		return selectedExtras.map((item) => ({
  // 			dbKey: item.value.fieldAlias,
  // 			tsKey: item.tsKey,
  // 			field: item.value,
  // 			relationTableTsKey: undefined,
  // 			isJson: false,
  // 			selection: [],
  // 		}));
  // 	}
  // 	if (isRoot) {
  // 		selection = [
  // 			...prepareSelectedColumns(),
  // 			...prepareSelectedExtras(),
  // 		];
  // 	}
  // 	if (hasUserDefinedWhere || orderBy.length > 0) {
  // 		tableFrom = new Subquery(
  // 			this.buildSelectQuery({
  // 				table: is(tableFrom, PgTable) ? aliasedTable(tableFrom, tableAlias) : tableFrom,
  // 				fields: {},
  // 				fieldsFlat: selectionForBuild.map(({ field }) => ({
  // 					path: [],
  // 					field: is(field, Column) ? aliasedTableColumn(field, tableAlias) : field,
  // 				})),
  // 				joins,
  // 				distinct,
  // 			}),
  // 			{},
  // 			tableAlias,
  // 		);
  // 		selectionForBuild = selection.map((item) =>
  // 			is(item.field, SQL.Aliased)
  // 				? { ...item, field: sql`${sql.identifier(tableAlias)}.${sql.identifier(item.field.fieldAlias)}` }
  // 				: item
  // 		);
  // 		joins = [];
  // 		distinct = undefined;
  // 	}
  // 	const result = this.buildSelectQuery({
  // 		table: is(tableFrom, PgTable) ? aliasedTable(tableFrom, tableAlias) : tableFrom,
  // 		fields: {},
  // 		fieldsFlat: selectionForBuild.map(({ field }) => ({
  // 			path: [],
  // 			field: is(field, Column) ? aliasedTableColumn(field, tableAlias) : field,
  // 		})),
  // 		where,
  // 		limit,
  // 		offset,
  // 		joins,
  // 		orderBy,
  // 		distinct,
  // 	});
  // 	return {
  // 		tableTsKey: tableConfig.tsName,
  // 		sql: result,
  // 		selection,
  // 	};
  // }
  buildRelationalQueryWithoutPK({
    fullSchema,
    schema,
    tableNamesMap,
    table,
    tableConfig,
    queryConfig: config,
    tableAlias,
    nestedQueryRelation,
    joinOn
  }) {
    let selection = [];
    let limit, offset, orderBy = [], where;
    const joins = [];
    if (config === true) {
      const selectionEntries = Object.entries(tableConfig.columns);
      selection = selectionEntries.map(([key, value]) => ({
        dbKey: value.name,
        tsKey: key,
        field: aliasedTableColumn(value, tableAlias),
        relationTableTsKey: void 0,
        isJson: false,
        selection: []
      }));
    } else {
      const aliasedColumns = Object.fromEntries(
        Object.entries(tableConfig.columns).map(([key, value]) => [key, aliasedTableColumn(value, tableAlias)])
      );
      if (config.where) {
        const whereSql = typeof config.where === "function" ? config.where(aliasedColumns, getOperators()) : config.where;
        where = whereSql && mapColumnsInSQLToAlias(whereSql, tableAlias);
      }
      const fieldsSelection = [];
      let selectedColumns = [];
      if (config.columns) {
        let isIncludeMode = false;
        for (const [field, value] of Object.entries(config.columns)) {
          if (value === void 0) {
            continue;
          }
          if (field in tableConfig.columns) {
            if (!isIncludeMode && value === true) {
              isIncludeMode = true;
            }
            selectedColumns.push(field);
          }
        }
        if (selectedColumns.length > 0) {
          selectedColumns = isIncludeMode ? selectedColumns.filter((c) => config.columns?.[c] === true) : Object.keys(tableConfig.columns).filter((key) => !selectedColumns.includes(key));
        }
      } else {
        selectedColumns = Object.keys(tableConfig.columns);
      }
      for (const field of selectedColumns) {
        const column = tableConfig.columns[field];
        fieldsSelection.push({ tsKey: field, value: column });
      }
      let selectedRelations = [];
      if (config.with) {
        selectedRelations = Object.entries(config.with).filter((entry) => !!entry[1]).map(([tsKey, queryConfig]) => ({ tsKey, queryConfig, relation: tableConfig.relations[tsKey] }));
      }
      let extras;
      if (config.extras) {
        extras = typeof config.extras === "function" ? config.extras(aliasedColumns, { sql }) : config.extras;
        for (const [tsKey, value] of Object.entries(extras)) {
          fieldsSelection.push({
            tsKey,
            value: mapColumnsInAliasedSQLToAlias(value, tableAlias)
          });
        }
      }
      for (const { tsKey, value } of fieldsSelection) {
        selection.push({
          dbKey: is(value, SQL.Aliased) ? value.fieldAlias : tableConfig.columns[tsKey].name,
          tsKey,
          field: is(value, Column) ? aliasedTableColumn(value, tableAlias) : value,
          relationTableTsKey: void 0,
          isJson: false,
          selection: []
        });
      }
      let orderByOrig = typeof config.orderBy === "function" ? config.orderBy(aliasedColumns, getOrderByOperators()) : config.orderBy ?? [];
      if (!Array.isArray(orderByOrig)) {
        orderByOrig = [orderByOrig];
      }
      orderBy = orderByOrig.map((orderByValue) => {
        if (is(orderByValue, Column)) {
          return aliasedTableColumn(orderByValue, tableAlias);
        }
        return mapColumnsInSQLToAlias(orderByValue, tableAlias);
      });
      limit = config.limit;
      offset = config.offset;
      for (const {
        tsKey: selectedRelationTsKey,
        queryConfig: selectedRelationConfigValue,
        relation
      } of selectedRelations) {
        const normalizedRelation = normalizeRelation(schema, tableNamesMap, relation);
        const relationTableName = getTableUniqueName(relation.referencedTable);
        const relationTableTsName = tableNamesMap[relationTableName];
        const relationTableAlias = `${tableAlias}_${selectedRelationTsKey}`;
        const joinOn2 = and(
          ...normalizedRelation.fields.map(
            (field2, i) => eq(
              aliasedTableColumn(normalizedRelation.references[i], relationTableAlias),
              aliasedTableColumn(field2, tableAlias)
            )
          )
        );
        const builtRelation = this.buildRelationalQueryWithoutPK({
          fullSchema,
          schema,
          tableNamesMap,
          table: fullSchema[relationTableTsName],
          tableConfig: schema[relationTableTsName],
          queryConfig: is(relation, One) ? selectedRelationConfigValue === true ? { limit: 1 } : { ...selectedRelationConfigValue, limit: 1 } : selectedRelationConfigValue,
          tableAlias: relationTableAlias,
          joinOn: joinOn2,
          nestedQueryRelation: relation
        });
        const field = sql`${sql.identifier(relationTableAlias)}.${sql.identifier("data")}`.as(selectedRelationTsKey);
        joins.push({
          on: sql`true`,
          table: new Subquery(builtRelation.sql, {}, relationTableAlias),
          alias: relationTableAlias,
          joinType: "left",
          lateral: true
        });
        selection.push({
          dbKey: selectedRelationTsKey,
          tsKey: selectedRelationTsKey,
          field,
          relationTableTsKey: relationTableTsName,
          isJson: true,
          selection: builtRelation.selection
        });
      }
    }
    if (selection.length === 0) {
      throw new DrizzleError({ message: `No fields selected for table "${tableConfig.tsName}" ("${tableAlias}")` });
    }
    let result;
    where = and(joinOn, where);
    if (nestedQueryRelation) {
      let field = sql`json_build_array(${sql.join(
        selection.map(
          ({ field: field2, tsKey, isJson }) => isJson ? sql`${sql.identifier(`${tableAlias}_${tsKey}`)}.${sql.identifier("data")}` : is(field2, SQL.Aliased) ? field2.sql : field2
        ),
        sql`, `
      )})`;
      if (is(nestedQueryRelation, Many)) {
        field = sql`coalesce(json_agg(${field}${orderBy.length > 0 ? sql` order by ${sql.join(orderBy, sql`, `)}` : void 0}), '[]'::json)`;
      }
      const nestedSelection = [{
        dbKey: "data",
        tsKey: "data",
        field: field.as("data"),
        isJson: true,
        relationTableTsKey: tableConfig.tsName,
        selection
      }];
      const needsSubquery = limit !== void 0 || offset !== void 0 || orderBy.length > 0;
      if (needsSubquery) {
        result = this.buildSelectQuery({
          table: aliasedTable(table, tableAlias),
          fields: {},
          fieldsFlat: [{
            path: [],
            field: sql.raw("*")
          }],
          where,
          limit,
          offset,
          orderBy,
          setOperators: []
        });
        where = void 0;
        limit = void 0;
        offset = void 0;
        orderBy = [];
      } else {
        result = aliasedTable(table, tableAlias);
      }
      result = this.buildSelectQuery({
        table: is(result, PgTable) ? result : new Subquery(result, {}, tableAlias),
        fields: {},
        fieldsFlat: nestedSelection.map(({ field: field2 }) => ({
          path: [],
          field: is(field2, Column) ? aliasedTableColumn(field2, tableAlias) : field2
        })),
        joins,
        where,
        limit,
        offset,
        orderBy,
        setOperators: []
      });
    } else {
      result = this.buildSelectQuery({
        table: aliasedTable(table, tableAlias),
        fields: {},
        fieldsFlat: selection.map(({ field }) => ({
          path: [],
          field: is(field, Column) ? aliasedTableColumn(field, tableAlias) : field
        })),
        joins,
        where,
        limit,
        offset,
        orderBy,
        setOperators: []
      });
    }
    return {
      tableTsKey: tableConfig.tsName,
      sql: result,
      selection
    };
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/query-builders/query-builder.js
var TypedQueryBuilder = class {
  static [entityKind] = "TypedQueryBuilder";
  /** @internal */
  getSelectedFields() {
    return this._.selectedFields;
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/query-builders/select.js
var PgSelectBuilder = class {
  static [entityKind] = "PgSelectBuilder";
  fields;
  session;
  dialect;
  withList = [];
  distinct;
  constructor(config) {
    this.fields = config.fields;
    this.session = config.session;
    this.dialect = config.dialect;
    if (config.withList) {
      this.withList = config.withList;
    }
    this.distinct = config.distinct;
  }
  authToken;
  /** @internal */
  setToken(token) {
    this.authToken = token;
    return this;
  }
  /**
   * Specify the table, subquery, or other target that you're
   * building a select query against.
   *
   * {@link https://www.postgresql.org/docs/current/sql-select.html#SQL-FROM | Postgres from documentation}
   */
  from(source) {
    const isPartialSelect = !!this.fields;
    const src = source;
    let fields;
    if (this.fields) {
      fields = this.fields;
    } else if (is(src, Subquery)) {
      fields = Object.fromEntries(
        Object.keys(src._.selectedFields).map((key) => [key, src[key]])
      );
    } else if (is(src, PgViewBase)) {
      fields = src[ViewBaseConfig].selectedFields;
    } else if (is(src, SQL)) {
      fields = {};
    } else {
      fields = getTableColumns(src);
    }
    return new PgSelectBase({
      table: src,
      fields,
      isPartialSelect,
      session: this.session,
      dialect: this.dialect,
      withList: this.withList,
      distinct: this.distinct
    }).setToken(this.authToken);
  }
};
var PgSelectQueryBuilderBase = class extends TypedQueryBuilder {
  static [entityKind] = "PgSelectQueryBuilder";
  _;
  config;
  joinsNotNullableMap;
  tableName;
  isPartialSelect;
  session;
  dialect;
  cacheConfig = void 0;
  usedTables = /* @__PURE__ */ new Set();
  constructor({ table, fields, isPartialSelect, session, dialect, withList, distinct }) {
    super();
    this.config = {
      withList,
      table,
      fields: { ...fields },
      distinct,
      setOperators: []
    };
    this.isPartialSelect = isPartialSelect;
    this.session = session;
    this.dialect = dialect;
    this._ = {
      selectedFields: fields,
      config: this.config
    };
    this.tableName = getTableLikeName(table);
    this.joinsNotNullableMap = typeof this.tableName === "string" ? { [this.tableName]: true } : {};
    for (const item of extractUsedTable(table)) this.usedTables.add(item);
  }
  /** @internal */
  getUsedTables() {
    return [...this.usedTables];
  }
  createJoin(joinType, lateral) {
    return (table, on) => {
      const baseTableName = this.tableName;
      const tableName = getTableLikeName(table);
      for (const item of extractUsedTable(table)) this.usedTables.add(item);
      if (typeof tableName === "string" && this.config.joins?.some((join) => join.alias === tableName)) {
        throw new Error(`Alias "${tableName}" is already used in this query`);
      }
      if (!this.isPartialSelect) {
        if (Object.keys(this.joinsNotNullableMap).length === 1 && typeof baseTableName === "string") {
          this.config.fields = {
            [baseTableName]: this.config.fields
          };
        }
        if (typeof tableName === "string" && !is(table, SQL)) {
          const selection = is(table, Subquery) ? table._.selectedFields : is(table, View) ? table[ViewBaseConfig].selectedFields : table[Table.Symbol.Columns];
          this.config.fields[tableName] = selection;
        }
      }
      if (typeof on === "function") {
        on = on(
          new Proxy(
            this.config.fields,
            new SelectionProxyHandler({ sqlAliasedBehavior: "sql", sqlBehavior: "sql" })
          )
        );
      }
      if (!this.config.joins) {
        this.config.joins = [];
      }
      this.config.joins.push({ on, table, joinType, alias: tableName, lateral });
      if (typeof tableName === "string") {
        switch (joinType) {
          case "left": {
            this.joinsNotNullableMap[tableName] = false;
            break;
          }
          case "right": {
            this.joinsNotNullableMap = Object.fromEntries(
              Object.entries(this.joinsNotNullableMap).map(([key]) => [key, false])
            );
            this.joinsNotNullableMap[tableName] = true;
            break;
          }
          case "cross":
          case "inner": {
            this.joinsNotNullableMap[tableName] = true;
            break;
          }
          case "full": {
            this.joinsNotNullableMap = Object.fromEntries(
              Object.entries(this.joinsNotNullableMap).map(([key]) => [key, false])
            );
            this.joinsNotNullableMap[tableName] = false;
            break;
          }
        }
      }
      return this;
    };
  }
  /**
   * Executes a `left join` operation by adding another table to the current query.
   *
   * Calling this method associates each row of the table with the corresponding row from the joined table, if a match is found. If no matching row exists, it sets all columns of the joined table to null.
   *
   * See docs: {@link https://orm.drizzle.team/docs/joins#left-join}
   *
   * @param table the table to join.
   * @param on the `on` clause.
   *
   * @example
   *
   * ```ts
   * // Select all users and their pets
   * const usersWithPets: { user: User; pets: Pet | null; }[] = await db.select()
   *   .from(users)
   *   .leftJoin(pets, eq(users.id, pets.ownerId))
   *
   * // Select userId and petId
   * const usersIdsAndPetIds: { userId: number; petId: number | null; }[] = await db.select({
   *   userId: users.id,
   *   petId: pets.id,
   * })
   *   .from(users)
   *   .leftJoin(pets, eq(users.id, pets.ownerId))
   * ```
   */
  leftJoin = this.createJoin("left", false);
  /**
   * Executes a `left join lateral` operation by adding subquery to the current query.
   *
   * A `lateral` join allows the right-hand expression to refer to columns from the left-hand side.
   *
   * Calling this method associates each row of the table with the corresponding row from the joined table, if a match is found. If no matching row exists, it sets all columns of the joined table to null.
   *
   * See docs: {@link https://orm.drizzle.team/docs/joins#left-join-lateral}
   *
   * @param table the subquery to join.
   * @param on the `on` clause.
   */
  leftJoinLateral = this.createJoin("left", true);
  /**
   * Executes a `right join` operation by adding another table to the current query.
   *
   * Calling this method associates each row of the joined table with the corresponding row from the main table, if a match is found. If no matching row exists, it sets all columns of the main table to null.
   *
   * See docs: {@link https://orm.drizzle.team/docs/joins#right-join}
   *
   * @param table the table to join.
   * @param on the `on` clause.
   *
   * @example
   *
   * ```ts
   * // Select all users and their pets
   * const usersWithPets: { user: User | null; pets: Pet; }[] = await db.select()
   *   .from(users)
   *   .rightJoin(pets, eq(users.id, pets.ownerId))
   *
   * // Select userId and petId
   * const usersIdsAndPetIds: { userId: number | null; petId: number; }[] = await db.select({
   *   userId: users.id,
   *   petId: pets.id,
   * })
   *   .from(users)
   *   .rightJoin(pets, eq(users.id, pets.ownerId))
   * ```
   */
  rightJoin = this.createJoin("right", false);
  /**
   * Executes an `inner join` operation, creating a new table by combining rows from two tables that have matching values.
   *
   * Calling this method retrieves rows that have corresponding entries in both joined tables. Rows without matching entries in either table are excluded, resulting in a table that includes only matching pairs.
   *
   * See docs: {@link https://orm.drizzle.team/docs/joins#inner-join}
   *
   * @param table the table to join.
   * @param on the `on` clause.
   *
   * @example
   *
   * ```ts
   * // Select all users and their pets
   * const usersWithPets: { user: User; pets: Pet; }[] = await db.select()
   *   .from(users)
   *   .innerJoin(pets, eq(users.id, pets.ownerId))
   *
   * // Select userId and petId
   * const usersIdsAndPetIds: { userId: number; petId: number; }[] = await db.select({
   *   userId: users.id,
   *   petId: pets.id,
   * })
   *   .from(users)
   *   .innerJoin(pets, eq(users.id, pets.ownerId))
   * ```
   */
  innerJoin = this.createJoin("inner", false);
  /**
   * Executes an `inner join lateral` operation, creating a new table by combining rows from two queries that have matching values.
   *
   * A `lateral` join allows the right-hand expression to refer to columns from the left-hand side.
   *
   * Calling this method retrieves rows that have corresponding entries in both joined tables. Rows without matching entries in either table are excluded, resulting in a table that includes only matching pairs.
   *
   * See docs: {@link https://orm.drizzle.team/docs/joins#inner-join-lateral}
   *
   * @param table the subquery to join.
   * @param on the `on` clause.
   */
  innerJoinLateral = this.createJoin("inner", true);
  /**
   * Executes a `full join` operation by combining rows from two tables into a new table.
   *
   * Calling this method retrieves all rows from both main and joined tables, merging rows with matching values and filling in `null` for non-matching columns.
   *
   * See docs: {@link https://orm.drizzle.team/docs/joins#full-join}
   *
   * @param table the table to join.
   * @param on the `on` clause.
   *
   * @example
   *
   * ```ts
   * // Select all users and their pets
   * const usersWithPets: { user: User | null; pets: Pet | null; }[] = await db.select()
   *   .from(users)
   *   .fullJoin(pets, eq(users.id, pets.ownerId))
   *
   * // Select userId and petId
   * const usersIdsAndPetIds: { userId: number | null; petId: number | null; }[] = await db.select({
   *   userId: users.id,
   *   petId: pets.id,
   * })
   *   .from(users)
   *   .fullJoin(pets, eq(users.id, pets.ownerId))
   * ```
   */
  fullJoin = this.createJoin("full", false);
  /**
   * Executes a `cross join` operation by combining rows from two tables into a new table.
   *
   * Calling this method retrieves all rows from both main and joined tables, merging all rows from each table.
   *
   * See docs: {@link https://orm.drizzle.team/docs/joins#cross-join}
   *
   * @param table the table to join.
   *
   * @example
   *
   * ```ts
   * // Select all users, each user with every pet
   * const usersWithPets: { user: User; pets: Pet; }[] = await db.select()
   *   .from(users)
   *   .crossJoin(pets)
   *
   * // Select userId and petId
   * const usersIdsAndPetIds: { userId: number; petId: number; }[] = await db.select({
   *   userId: users.id,
   *   petId: pets.id,
   * })
   *   .from(users)
   *   .crossJoin(pets)
   * ```
   */
  crossJoin = this.createJoin("cross", false);
  /**
   * Executes a `cross join lateral` operation by combining rows from two queries into a new table.
   *
   * A `lateral` join allows the right-hand expression to refer to columns from the left-hand side.
   *
   * Calling this method retrieves all rows from both main and joined queries, merging all rows from each query.
   *
   * See docs: {@link https://orm.drizzle.team/docs/joins#cross-join-lateral}
   *
   * @param table the query to join.
   */
  crossJoinLateral = this.createJoin("cross", true);
  createSetOperator(type, isAll) {
    return (rightSelection) => {
      const rightSelect = typeof rightSelection === "function" ? rightSelection(getPgSetOperators()) : rightSelection;
      if (!haveSameKeys(this.getSelectedFields(), rightSelect.getSelectedFields())) {
        throw new Error(
          "Set operator error (union / intersect / except): selected fields are not the same or are in a different order"
        );
      }
      this.config.setOperators.push({ type, isAll, rightSelect });
      return this;
    };
  }
  /**
   * Adds `union` set operator to the query.
   *
   * Calling this method will combine the result sets of the `select` statements and remove any duplicate rows that appear across them.
   *
   * See docs: {@link https://orm.drizzle.team/docs/set-operations#union}
   *
   * @example
   *
   * ```ts
   * // Select all unique names from customers and users tables
   * await db.select({ name: users.name })
   *   .from(users)
   *   .union(
   *     db.select({ name: customers.name }).from(customers)
   *   );
   * // or
   * import { union } from 'drizzle-orm/pg-core'
   *
   * await union(
   *   db.select({ name: users.name }).from(users),
   *   db.select({ name: customers.name }).from(customers)
   * );
   * ```
   */
  union = this.createSetOperator("union", false);
  /**
   * Adds `union all` set operator to the query.
   *
   * Calling this method will combine the result-set of the `select` statements and keep all duplicate rows that appear across them.
   *
   * See docs: {@link https://orm.drizzle.team/docs/set-operations#union-all}
   *
   * @example
   *
   * ```ts
   * // Select all transaction ids from both online and in-store sales
   * await db.select({ transaction: onlineSales.transactionId })
   *   .from(onlineSales)
   *   .unionAll(
   *     db.select({ transaction: inStoreSales.transactionId }).from(inStoreSales)
   *   );
   * // or
   * import { unionAll } from 'drizzle-orm/pg-core'
   *
   * await unionAll(
   *   db.select({ transaction: onlineSales.transactionId }).from(onlineSales),
   *   db.select({ transaction: inStoreSales.transactionId }).from(inStoreSales)
   * );
   * ```
   */
  unionAll = this.createSetOperator("union", true);
  /**
   * Adds `intersect` set operator to the query.
   *
   * Calling this method will retain only the rows that are present in both result sets and eliminate duplicates.
   *
   * See docs: {@link https://orm.drizzle.team/docs/set-operations#intersect}
   *
   * @example
   *
   * ```ts
   * // Select course names that are offered in both departments A and B
   * await db.select({ courseName: depA.courseName })
   *   .from(depA)
   *   .intersect(
   *     db.select({ courseName: depB.courseName }).from(depB)
   *   );
   * // or
   * import { intersect } from 'drizzle-orm/pg-core'
   *
   * await intersect(
   *   db.select({ courseName: depA.courseName }).from(depA),
   *   db.select({ courseName: depB.courseName }).from(depB)
   * );
   * ```
   */
  intersect = this.createSetOperator("intersect", false);
  /**
   * Adds `intersect all` set operator to the query.
   *
   * Calling this method will retain only the rows that are present in both result sets including all duplicates.
   *
   * See docs: {@link https://orm.drizzle.team/docs/set-operations#intersect-all}
   *
   * @example
   *
   * ```ts
   * // Select all products and quantities that are ordered by both regular and VIP customers
   * await db.select({
   *   productId: regularCustomerOrders.productId,
   *   quantityOrdered: regularCustomerOrders.quantityOrdered
   * })
   * .from(regularCustomerOrders)
   * .intersectAll(
   *   db.select({
   *     productId: vipCustomerOrders.productId,
   *     quantityOrdered: vipCustomerOrders.quantityOrdered
   *   })
   *   .from(vipCustomerOrders)
   * );
   * // or
   * import { intersectAll } from 'drizzle-orm/pg-core'
   *
   * await intersectAll(
   *   db.select({
   *     productId: regularCustomerOrders.productId,
   *     quantityOrdered: regularCustomerOrders.quantityOrdered
   *   })
   *   .from(regularCustomerOrders),
   *   db.select({
   *     productId: vipCustomerOrders.productId,
   *     quantityOrdered: vipCustomerOrders.quantityOrdered
   *   })
   *   .from(vipCustomerOrders)
   * );
   * ```
   */
  intersectAll = this.createSetOperator("intersect", true);
  /**
   * Adds `except` set operator to the query.
   *
   * Calling this method will retrieve all unique rows from the left query, except for the rows that are present in the result set of the right query.
   *
   * See docs: {@link https://orm.drizzle.team/docs/set-operations#except}
   *
   * @example
   *
   * ```ts
   * // Select all courses offered in department A but not in department B
   * await db.select({ courseName: depA.courseName })
   *   .from(depA)
   *   .except(
   *     db.select({ courseName: depB.courseName }).from(depB)
   *   );
   * // or
   * import { except } from 'drizzle-orm/pg-core'
   *
   * await except(
   *   db.select({ courseName: depA.courseName }).from(depA),
   *   db.select({ courseName: depB.courseName }).from(depB)
   * );
   * ```
   */
  except = this.createSetOperator("except", false);
  /**
   * Adds `except all` set operator to the query.
   *
   * Calling this method will retrieve all rows from the left query, except for the rows that are present in the result set of the right query.
   *
   * See docs: {@link https://orm.drizzle.team/docs/set-operations#except-all}
   *
   * @example
   *
   * ```ts
   * // Select all products that are ordered by regular customers but not by VIP customers
   * await db.select({
   *   productId: regularCustomerOrders.productId,
   *   quantityOrdered: regularCustomerOrders.quantityOrdered,
   * })
   * .from(regularCustomerOrders)
   * .exceptAll(
   *   db.select({
   *     productId: vipCustomerOrders.productId,
   *     quantityOrdered: vipCustomerOrders.quantityOrdered,
   *   })
   *   .from(vipCustomerOrders)
   * );
   * // or
   * import { exceptAll } from 'drizzle-orm/pg-core'
   *
   * await exceptAll(
   *   db.select({
   *     productId: regularCustomerOrders.productId,
   *     quantityOrdered: regularCustomerOrders.quantityOrdered
   *   })
   *   .from(regularCustomerOrders),
   *   db.select({
   *     productId: vipCustomerOrders.productId,
   *     quantityOrdered: vipCustomerOrders.quantityOrdered
   *   })
   *   .from(vipCustomerOrders)
   * );
   * ```
   */
  exceptAll = this.createSetOperator("except", true);
  /** @internal */
  addSetOperators(setOperators) {
    this.config.setOperators.push(...setOperators);
    return this;
  }
  /**
   * Adds a `where` clause to the query.
   *
   * Calling this method will select only those rows that fulfill a specified condition.
   *
   * See docs: {@link https://orm.drizzle.team/docs/select#filtering}
   *
   * @param where the `where` clause.
   *
   * @example
   * You can use conditional operators and `sql function` to filter the rows to be selected.
   *
   * ```ts
   * // Select all cars with green color
   * await db.select().from(cars).where(eq(cars.color, 'green'));
   * // or
   * await db.select().from(cars).where(sql`${cars.color} = 'green'`)
   * ```
   *
   * You can logically combine conditional operators with `and()` and `or()` operators:
   *
   * ```ts
   * // Select all BMW cars with a green color
   * await db.select().from(cars).where(and(eq(cars.color, 'green'), eq(cars.brand, 'BMW')));
   *
   * // Select all cars with the green or blue color
   * await db.select().from(cars).where(or(eq(cars.color, 'green'), eq(cars.color, 'blue')));
   * ```
   */
  where(where) {
    if (typeof where === "function") {
      where = where(
        new Proxy(
          this.config.fields,
          new SelectionProxyHandler({ sqlAliasedBehavior: "sql", sqlBehavior: "sql" })
        )
      );
    }
    this.config.where = where;
    return this;
  }
  /**
   * Adds a `having` clause to the query.
   *
   * Calling this method will select only those rows that fulfill a specified condition. It is typically used with aggregate functions to filter the aggregated data based on a specified condition.
   *
   * See docs: {@link https://orm.drizzle.team/docs/select#aggregations}
   *
   * @param having the `having` clause.
   *
   * @example
   *
   * ```ts
   * // Select all brands with more than one car
   * await db.select({
   * 	brand: cars.brand,
   * 	count: sql<number>`cast(count(${cars.id}) as int)`,
   * })
   *   .from(cars)
   *   .groupBy(cars.brand)
   *   .having(({ count }) => gt(count, 1));
   * ```
   */
  having(having) {
    if (typeof having === "function") {
      having = having(
        new Proxy(
          this.config.fields,
          new SelectionProxyHandler({ sqlAliasedBehavior: "sql", sqlBehavior: "sql" })
        )
      );
    }
    this.config.having = having;
    return this;
  }
  groupBy(...columns) {
    if (typeof columns[0] === "function") {
      const groupBy = columns[0](
        new Proxy(
          this.config.fields,
          new SelectionProxyHandler({ sqlAliasedBehavior: "alias", sqlBehavior: "sql" })
        )
      );
      this.config.groupBy = Array.isArray(groupBy) ? groupBy : [groupBy];
    } else {
      this.config.groupBy = columns;
    }
    return this;
  }
  orderBy(...columns) {
    if (typeof columns[0] === "function") {
      const orderBy = columns[0](
        new Proxy(
          this.config.fields,
          new SelectionProxyHandler({ sqlAliasedBehavior: "alias", sqlBehavior: "sql" })
        )
      );
      const orderByArray = Array.isArray(orderBy) ? orderBy : [orderBy];
      if (this.config.setOperators.length > 0) {
        this.config.setOperators.at(-1).orderBy = orderByArray;
      } else {
        this.config.orderBy = orderByArray;
      }
    } else {
      const orderByArray = columns;
      if (this.config.setOperators.length > 0) {
        this.config.setOperators.at(-1).orderBy = orderByArray;
      } else {
        this.config.orderBy = orderByArray;
      }
    }
    return this;
  }
  /**
   * Adds a `limit` clause to the query.
   *
   * Calling this method will set the maximum number of rows that will be returned by this query.
   *
   * See docs: {@link https://orm.drizzle.team/docs/select#limit--offset}
   *
   * @param limit the `limit` clause.
   *
   * @example
   *
   * ```ts
   * // Get the first 10 people from this query.
   * await db.select().from(people).limit(10);
   * ```
   */
  limit(limit) {
    if (this.config.setOperators.length > 0) {
      this.config.setOperators.at(-1).limit = limit;
    } else {
      this.config.limit = limit;
    }
    return this;
  }
  /**
   * Adds an `offset` clause to the query.
   *
   * Calling this method will skip a number of rows when returning results from this query.
   *
   * See docs: {@link https://orm.drizzle.team/docs/select#limit--offset}
   *
   * @param offset the `offset` clause.
   *
   * @example
   *
   * ```ts
   * // Get the 10th-20th people from this query.
   * await db.select().from(people).offset(10).limit(10);
   * ```
   */
  offset(offset) {
    if (this.config.setOperators.length > 0) {
      this.config.setOperators.at(-1).offset = offset;
    } else {
      this.config.offset = offset;
    }
    return this;
  }
  /**
   * Adds a `for` clause to the query.
   *
   * Calling this method will specify a lock strength for this query that controls how strictly it acquires exclusive access to the rows being queried.
   *
   * See docs: {@link https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE}
   *
   * @param strength the lock strength.
   * @param config the lock configuration.
   */
  for(strength, config = {}) {
    this.config.lockingClause = { strength, config };
    return this;
  }
  /** @internal */
  getSQL() {
    return this.dialect.buildSelectQuery(this.config);
  }
  toSQL() {
    const { typings: _typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
    return rest;
  }
  as(alias) {
    const usedTables = [];
    usedTables.push(...extractUsedTable(this.config.table));
    if (this.config.joins) {
      for (const it of this.config.joins) usedTables.push(...extractUsedTable(it.table));
    }
    return new Proxy(
      new Subquery(this.getSQL(), this.config.fields, alias, false, [...new Set(usedTables)]),
      new SelectionProxyHandler({ alias, sqlAliasedBehavior: "alias", sqlBehavior: "error" })
    );
  }
  /** @internal */
  getSelectedFields() {
    return new Proxy(
      this.config.fields,
      new SelectionProxyHandler({ alias: this.tableName, sqlAliasedBehavior: "alias", sqlBehavior: "error" })
    );
  }
  $dynamic() {
    return this;
  }
  $withCache(config) {
    this.cacheConfig = config === void 0 ? { config: {}, enable: true, autoInvalidate: true } : config === false ? { enable: false } : { enable: true, autoInvalidate: true, ...config };
    return this;
  }
};
var PgSelectBase = class extends PgSelectQueryBuilderBase {
  static [entityKind] = "PgSelect";
  /** @internal */
  _prepare(name) {
    const { session, config, dialect, joinsNotNullableMap, authToken, cacheConfig, usedTables } = this;
    if (!session) {
      throw new Error("Cannot execute a query on a query builder. Please use a database instance instead.");
    }
    const { fields } = config;
    return tracer.startActiveSpan("drizzle.prepareQuery", () => {
      const fieldsList = orderSelectedFields(fields);
      const query = session.prepareQuery(dialect.sqlToQuery(this.getSQL()), fieldsList, name, true, void 0, {
        type: "select",
        tables: [...usedTables]
      }, cacheConfig);
      query.joinsNotNullableMap = joinsNotNullableMap;
      return query.setToken(authToken);
    });
  }
  /**
   * Create a prepared statement for this query. This allows
   * the database to remember this query for the given session
   * and call it by name, rather than specifying the full query.
   *
   * {@link https://www.postgresql.org/docs/current/sql-prepare.html | Postgres prepare documentation}
   */
  prepare(name) {
    return this._prepare(name);
  }
  authToken;
  /** @internal */
  setToken(token) {
    this.authToken = token;
    return this;
  }
  execute = (placeholderValues) => {
    return tracer.startActiveSpan("drizzle.operation", () => {
      return this._prepare().execute(placeholderValues, this.authToken);
    });
  };
};
applyMixins(PgSelectBase, [QueryPromise]);
function createSetOperator(type, isAll) {
  return (leftSelect, rightSelect, ...restSelects) => {
    const setOperators = [rightSelect, ...restSelects].map((select2) => ({
      type,
      isAll,
      rightSelect: select2
    }));
    for (const setOperator of setOperators) {
      if (!haveSameKeys(leftSelect.getSelectedFields(), setOperator.rightSelect.getSelectedFields())) {
        throw new Error(
          "Set operator error (union / intersect / except): selected fields are not the same or are in a different order"
        );
      }
    }
    return leftSelect.addSetOperators(setOperators);
  };
}
var getPgSetOperators = () => ({
  union,
  unionAll,
  intersect,
  intersectAll,
  except,
  exceptAll
});
var union = createSetOperator("union", false);
var unionAll = createSetOperator("union", true);
var intersect = createSetOperator("intersect", false);
var intersectAll = createSetOperator("intersect", true);
var except = createSetOperator("except", false);
var exceptAll = createSetOperator("except", true);

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/query-builders/query-builder.js
var QueryBuilder = class {
  static [entityKind] = "PgQueryBuilder";
  dialect;
  dialectConfig;
  constructor(dialect) {
    this.dialect = is(dialect, PgDialect) ? dialect : void 0;
    this.dialectConfig = is(dialect, PgDialect) ? void 0 : dialect;
  }
  $with = (alias, selection) => {
    const queryBuilder = this;
    const as = (qb) => {
      if (typeof qb === "function") {
        qb = qb(queryBuilder);
      }
      return new Proxy(
        new WithSubquery(
          qb.getSQL(),
          selection ?? ("getSelectedFields" in qb ? qb.getSelectedFields() ?? {} : {}),
          alias,
          true
        ),
        new SelectionProxyHandler({ alias, sqlAliasedBehavior: "alias", sqlBehavior: "error" })
      );
    };
    return { as };
  };
  with(...queries) {
    const self = this;
    function select2(fields) {
      return new PgSelectBuilder({
        fields: fields ?? void 0,
        session: void 0,
        dialect: self.getDialect(),
        withList: queries
      });
    }
    function selectDistinct(fields) {
      return new PgSelectBuilder({
        fields: fields ?? void 0,
        session: void 0,
        dialect: self.getDialect(),
        distinct: true
      });
    }
    function selectDistinctOn(on, fields) {
      return new PgSelectBuilder({
        fields: fields ?? void 0,
        session: void 0,
        dialect: self.getDialect(),
        distinct: { on }
      });
    }
    return { select: select2, selectDistinct, selectDistinctOn };
  }
  select(fields) {
    return new PgSelectBuilder({
      fields: fields ?? void 0,
      session: void 0,
      dialect: this.getDialect()
    });
  }
  selectDistinct(fields) {
    return new PgSelectBuilder({
      fields: fields ?? void 0,
      session: void 0,
      dialect: this.getDialect(),
      distinct: true
    });
  }
  selectDistinctOn(on, fields) {
    return new PgSelectBuilder({
      fields: fields ?? void 0,
      session: void 0,
      dialect: this.getDialect(),
      distinct: { on }
    });
  }
  // Lazy load dialect to avoid circular dependency
  getDialect() {
    if (!this.dialect) {
      this.dialect = new PgDialect(this.dialectConfig);
    }
    return this.dialect;
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/utils.js
function extractUsedTable(table) {
  if (is(table, PgTable)) {
    return [table[Schema] ? `${table[Schema]}.${table[Table.Symbol.BaseName]}` : table[Table.Symbol.BaseName]];
  }
  if (is(table, Subquery)) {
    return table._.usedTables ?? [];
  }
  if (is(table, SQL)) {
    return table.usedTables ?? [];
  }
  return [];
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/query-builders/delete.js
var PgDeleteBase = class extends QueryPromise {
  constructor(table, session, dialect, withList) {
    super();
    this.session = session;
    this.dialect = dialect;
    this.config = { table, withList };
  }
  static [entityKind] = "PgDelete";
  config;
  cacheConfig;
  /**
   * Adds a `where` clause to the query.
   *
   * Calling this method will delete only those rows that fulfill a specified condition.
   *
   * See docs: {@link https://orm.drizzle.team/docs/delete}
   *
   * @param where the `where` clause.
   *
   * @example
   * You can use conditional operators and `sql function` to filter the rows to be deleted.
   *
   * ```ts
   * // Delete all cars with green color
   * await db.delete(cars).where(eq(cars.color, 'green'));
   * // or
   * await db.delete(cars).where(sql`${cars.color} = 'green'`)
   * ```
   *
   * You can logically combine conditional operators with `and()` and `or()` operators:
   *
   * ```ts
   * // Delete all BMW cars with a green color
   * await db.delete(cars).where(and(eq(cars.color, 'green'), eq(cars.brand, 'BMW')));
   *
   * // Delete all cars with the green or blue color
   * await db.delete(cars).where(or(eq(cars.color, 'green'), eq(cars.color, 'blue')));
   * ```
   */
  where(where) {
    this.config.where = where;
    return this;
  }
  returning(fields = this.config.table[Table.Symbol.Columns]) {
    this.config.returningFields = fields;
    this.config.returning = orderSelectedFields(fields);
    return this;
  }
  /** @internal */
  getSQL() {
    return this.dialect.buildDeleteQuery(this.config);
  }
  toSQL() {
    const { typings: _typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
    return rest;
  }
  /** @internal */
  _prepare(name) {
    return tracer.startActiveSpan("drizzle.prepareQuery", () => {
      return this.session.prepareQuery(this.dialect.sqlToQuery(this.getSQL()), this.config.returning, name, true, void 0, {
        type: "delete",
        tables: extractUsedTable(this.config.table)
      }, this.cacheConfig);
    });
  }
  prepare(name) {
    return this._prepare(name);
  }
  authToken;
  /** @internal */
  setToken(token) {
    this.authToken = token;
    return this;
  }
  execute = (placeholderValues) => {
    return tracer.startActiveSpan("drizzle.operation", () => {
      return this._prepare().execute(placeholderValues, this.authToken);
    });
  };
  /** @internal */
  getSelectedFields() {
    return this.config.returningFields ? new Proxy(
      this.config.returningFields,
      new SelectionProxyHandler({
        alias: getTableName(this.config.table),
        sqlAliasedBehavior: "alias",
        sqlBehavior: "error"
      })
    ) : void 0;
  }
  $dynamic() {
    return this;
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/query-builders/insert.js
var PgInsertBuilder = class {
  constructor(table, session, dialect, withList, overridingSystemValue_) {
    this.table = table;
    this.session = session;
    this.dialect = dialect;
    this.withList = withList;
    this.overridingSystemValue_ = overridingSystemValue_;
  }
  static [entityKind] = "PgInsertBuilder";
  authToken;
  /** @internal */
  setToken(token) {
    this.authToken = token;
    return this;
  }
  overridingSystemValue() {
    this.overridingSystemValue_ = true;
    return this;
  }
  values(values2) {
    values2 = Array.isArray(values2) ? values2 : [values2];
    if (values2.length === 0) {
      throw new Error("values() must be called with at least one value");
    }
    const mappedValues = values2.map((entry) => {
      const result = {};
      const cols = this.table[Table.Symbol.Columns];
      for (const colKey of Object.keys(entry)) {
        const colValue = entry[colKey];
        result[colKey] = is(colValue, SQL) ? colValue : new Param(colValue, cols[colKey]);
      }
      return result;
    });
    return new PgInsertBase(
      this.table,
      mappedValues,
      this.session,
      this.dialect,
      this.withList,
      false,
      this.overridingSystemValue_
    ).setToken(this.authToken);
  }
  select(selectQuery) {
    const select2 = typeof selectQuery === "function" ? selectQuery(new QueryBuilder()) : selectQuery;
    if (!is(select2, SQL) && !haveSameKeys(this.table[Columns], select2._.selectedFields)) {
      throw new Error(
        "Insert select error: selected fields are not the same or are in a different order compared to the table definition"
      );
    }
    return new PgInsertBase(this.table, select2, this.session, this.dialect, this.withList, true);
  }
};
var PgInsertBase = class extends QueryPromise {
  constructor(table, values2, session, dialect, withList, select2, overridingSystemValue_) {
    super();
    this.session = session;
    this.dialect = dialect;
    this.config = { table, values: values2, withList, select: select2, overridingSystemValue_ };
  }
  static [entityKind] = "PgInsert";
  config;
  cacheConfig;
  returning(fields = this.config.table[Table.Symbol.Columns]) {
    this.config.returningFields = fields;
    this.config.returning = orderSelectedFields(fields);
    return this;
  }
  /**
   * Adds an `on conflict do nothing` clause to the query.
   *
   * Calling this method simply avoids inserting a row as its alternative action.
   *
   * See docs: {@link https://orm.drizzle.team/docs/insert#on-conflict-do-nothing}
   *
   * @param config The `target` and `where` clauses.
   *
   * @example
   * ```ts
   * // Insert one row and cancel the insert if there's a conflict
   * await db.insert(cars)
   *   .values({ id: 1, brand: 'BMW' })
   *   .onConflictDoNothing();
   *
   * // Explicitly specify conflict target
   * await db.insert(cars)
   *   .values({ id: 1, brand: 'BMW' })
   *   .onConflictDoNothing({ target: cars.id });
   * ```
   */
  onConflictDoNothing(config = {}) {
    if (config.target === void 0) {
      this.config.onConflict = sql`do nothing`;
    } else {
      let targetColumn = "";
      targetColumn = Array.isArray(config.target) ? config.target.map((it) => this.dialect.escapeName(this.dialect.casing.getColumnCasing(it))).join(",") : this.dialect.escapeName(this.dialect.casing.getColumnCasing(config.target));
      const whereSql = config.where ? sql` where ${config.where}` : void 0;
      this.config.onConflict = sql`(${sql.raw(targetColumn)})${whereSql} do nothing`;
    }
    return this;
  }
  /**
   * Adds an `on conflict do update` clause to the query.
   *
   * Calling this method will update the existing row that conflicts with the row proposed for insertion as its alternative action.
   *
   * See docs: {@link https://orm.drizzle.team/docs/insert#upserts-and-conflicts}
   *
   * @param config The `target`, `set` and `where` clauses.
   *
   * @example
   * ```ts
   * // Update the row if there's a conflict
   * await db.insert(cars)
   *   .values({ id: 1, brand: 'BMW' })
   *   .onConflictDoUpdate({
   *     target: cars.id,
   *     set: { brand: 'Porsche' }
   *   });
   *
   * // Upsert with 'where' clause
   * await db.insert(cars)
   *   .values({ id: 1, brand: 'BMW' })
   *   .onConflictDoUpdate({
   *     target: cars.id,
   *     set: { brand: 'newBMW' },
   *     targetWhere: sql`${cars.createdAt} > '2023-01-01'::date`,
   *   });
   * ```
   */
  onConflictDoUpdate(config) {
    if (config.where && (config.targetWhere || config.setWhere)) {
      throw new Error(
        'You cannot use both "where" and "targetWhere"/"setWhere" at the same time - "where" is deprecated, use "targetWhere" or "setWhere" instead.'
      );
    }
    const whereSql = config.where ? sql` where ${config.where}` : void 0;
    const targetWhereSql = config.targetWhere ? sql` where ${config.targetWhere}` : void 0;
    const setWhereSql = config.setWhere ? sql` where ${config.setWhere}` : void 0;
    const setSql = this.dialect.buildUpdateSet(this.config.table, mapUpdateSet(this.config.table, config.set));
    let targetColumn = "";
    targetColumn = Array.isArray(config.target) ? config.target.map((it) => this.dialect.escapeName(this.dialect.casing.getColumnCasing(it))).join(",") : this.dialect.escapeName(this.dialect.casing.getColumnCasing(config.target));
    this.config.onConflict = sql`(${sql.raw(targetColumn)})${targetWhereSql} do update set ${setSql}${whereSql}${setWhereSql}`;
    return this;
  }
  /** @internal */
  getSQL() {
    return this.dialect.buildInsertQuery(this.config);
  }
  toSQL() {
    const { typings: _typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
    return rest;
  }
  /** @internal */
  _prepare(name) {
    return tracer.startActiveSpan("drizzle.prepareQuery", () => {
      return this.session.prepareQuery(this.dialect.sqlToQuery(this.getSQL()), this.config.returning, name, true, void 0, {
        type: "insert",
        tables: extractUsedTable(this.config.table)
      }, this.cacheConfig);
    });
  }
  prepare(name) {
    return this._prepare(name);
  }
  authToken;
  /** @internal */
  setToken(token) {
    this.authToken = token;
    return this;
  }
  execute = (placeholderValues) => {
    return tracer.startActiveSpan("drizzle.operation", () => {
      return this._prepare().execute(placeholderValues, this.authToken);
    });
  };
  /** @internal */
  getSelectedFields() {
    return this.config.returningFields ? new Proxy(
      this.config.returningFields,
      new SelectionProxyHandler({
        alias: getTableName(this.config.table),
        sqlAliasedBehavior: "alias",
        sqlBehavior: "error"
      })
    ) : void 0;
  }
  $dynamic() {
    return this;
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/query-builders/refresh-materialized-view.js
var PgRefreshMaterializedView = class extends QueryPromise {
  constructor(view, session, dialect) {
    super();
    this.session = session;
    this.dialect = dialect;
    this.config = { view };
  }
  static [entityKind] = "PgRefreshMaterializedView";
  config;
  concurrently() {
    if (this.config.withNoData !== void 0) {
      throw new Error("Cannot use concurrently and withNoData together");
    }
    this.config.concurrently = true;
    return this;
  }
  withNoData() {
    if (this.config.concurrently !== void 0) {
      throw new Error("Cannot use concurrently and withNoData together");
    }
    this.config.withNoData = true;
    return this;
  }
  /** @internal */
  getSQL() {
    return this.dialect.buildRefreshMaterializedViewQuery(this.config);
  }
  toSQL() {
    const { typings: _typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
    return rest;
  }
  /** @internal */
  _prepare(name) {
    return tracer.startActiveSpan("drizzle.prepareQuery", () => {
      return this.session.prepareQuery(this.dialect.sqlToQuery(this.getSQL()), void 0, name, true);
    });
  }
  prepare(name) {
    return this._prepare(name);
  }
  authToken;
  /** @internal */
  setToken(token) {
    this.authToken = token;
    return this;
  }
  execute = (placeholderValues) => {
    return tracer.startActiveSpan("drizzle.operation", () => {
      return this._prepare().execute(placeholderValues, this.authToken);
    });
  };
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/query-builders/update.js
var PgUpdateBuilder = class {
  constructor(table, session, dialect, withList) {
    this.table = table;
    this.session = session;
    this.dialect = dialect;
    this.withList = withList;
  }
  static [entityKind] = "PgUpdateBuilder";
  authToken;
  setToken(token) {
    this.authToken = token;
    return this;
  }
  set(values2) {
    return new PgUpdateBase(
      this.table,
      mapUpdateSet(this.table, values2),
      this.session,
      this.dialect,
      this.withList
    ).setToken(this.authToken);
  }
};
var PgUpdateBase = class extends QueryPromise {
  constructor(table, set, session, dialect, withList) {
    super();
    this.session = session;
    this.dialect = dialect;
    this.config = { set, table, withList, joins: [] };
    this.tableName = getTableLikeName(table);
    this.joinsNotNullableMap = typeof this.tableName === "string" ? { [this.tableName]: true } : {};
  }
  static [entityKind] = "PgUpdate";
  config;
  tableName;
  joinsNotNullableMap;
  cacheConfig;
  from(source) {
    const src = source;
    const tableName = getTableLikeName(src);
    if (typeof tableName === "string") {
      this.joinsNotNullableMap[tableName] = true;
    }
    this.config.from = src;
    return this;
  }
  getTableLikeFields(table) {
    if (is(table, PgTable)) {
      return table[Table.Symbol.Columns];
    } else if (is(table, Subquery)) {
      return table._.selectedFields;
    }
    return table[ViewBaseConfig].selectedFields;
  }
  createJoin(joinType) {
    return (table, on) => {
      const tableName = getTableLikeName(table);
      if (typeof tableName === "string" && this.config.joins.some((join) => join.alias === tableName)) {
        throw new Error(`Alias "${tableName}" is already used in this query`);
      }
      if (typeof on === "function") {
        const from = this.config.from && !is(this.config.from, SQL) ? this.getTableLikeFields(this.config.from) : void 0;
        on = on(
          new Proxy(
            this.config.table[Table.Symbol.Columns],
            new SelectionProxyHandler({ sqlAliasedBehavior: "sql", sqlBehavior: "sql" })
          ),
          from && new Proxy(
            from,
            new SelectionProxyHandler({ sqlAliasedBehavior: "sql", sqlBehavior: "sql" })
          )
        );
      }
      this.config.joins.push({ on, table, joinType, alias: tableName });
      if (typeof tableName === "string") {
        switch (joinType) {
          case "left": {
            this.joinsNotNullableMap[tableName] = false;
            break;
          }
          case "right": {
            this.joinsNotNullableMap = Object.fromEntries(
              Object.entries(this.joinsNotNullableMap).map(([key]) => [key, false])
            );
            this.joinsNotNullableMap[tableName] = true;
            break;
          }
          case "inner": {
            this.joinsNotNullableMap[tableName] = true;
            break;
          }
          case "full": {
            this.joinsNotNullableMap = Object.fromEntries(
              Object.entries(this.joinsNotNullableMap).map(([key]) => [key, false])
            );
            this.joinsNotNullableMap[tableName] = false;
            break;
          }
        }
      }
      return this;
    };
  }
  leftJoin = this.createJoin("left");
  rightJoin = this.createJoin("right");
  innerJoin = this.createJoin("inner");
  fullJoin = this.createJoin("full");
  /**
   * Adds a 'where' clause to the query.
   *
   * Calling this method will update only those rows that fulfill a specified condition.
   *
   * See docs: {@link https://orm.drizzle.team/docs/update}
   *
   * @param where the 'where' clause.
   *
   * @example
   * You can use conditional operators and `sql function` to filter the rows to be updated.
   *
   * ```ts
   * // Update all cars with green color
   * await db.update(cars).set({ color: 'red' })
   *   .where(eq(cars.color, 'green'));
   * // or
   * await db.update(cars).set({ color: 'red' })
   *   .where(sql`${cars.color} = 'green'`)
   * ```
   *
   * You can logically combine conditional operators with `and()` and `or()` operators:
   *
   * ```ts
   * // Update all BMW cars with a green color
   * await db.update(cars).set({ color: 'red' })
   *   .where(and(eq(cars.color, 'green'), eq(cars.brand, 'BMW')));
   *
   * // Update all cars with the green or blue color
   * await db.update(cars).set({ color: 'red' })
   *   .where(or(eq(cars.color, 'green'), eq(cars.color, 'blue')));
   * ```
   */
  where(where) {
    this.config.where = where;
    return this;
  }
  returning(fields) {
    if (!fields) {
      fields = Object.assign({}, this.config.table[Table.Symbol.Columns]);
      if (this.config.from) {
        const tableName = getTableLikeName(this.config.from);
        if (typeof tableName === "string" && this.config.from && !is(this.config.from, SQL)) {
          const fromFields = this.getTableLikeFields(this.config.from);
          fields[tableName] = fromFields;
        }
        for (const join of this.config.joins) {
          const tableName2 = getTableLikeName(join.table);
          if (typeof tableName2 === "string" && !is(join.table, SQL)) {
            const fromFields = this.getTableLikeFields(join.table);
            fields[tableName2] = fromFields;
          }
        }
      }
    }
    this.config.returningFields = fields;
    this.config.returning = orderSelectedFields(fields);
    return this;
  }
  /** @internal */
  getSQL() {
    return this.dialect.buildUpdateQuery(this.config);
  }
  toSQL() {
    const { typings: _typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
    return rest;
  }
  /** @internal */
  _prepare(name) {
    const query = this.session.prepareQuery(this.dialect.sqlToQuery(this.getSQL()), this.config.returning, name, true, void 0, {
      type: "insert",
      tables: extractUsedTable(this.config.table)
    }, this.cacheConfig);
    query.joinsNotNullableMap = this.joinsNotNullableMap;
    return query;
  }
  prepare(name) {
    return this._prepare(name);
  }
  authToken;
  /** @internal */
  setToken(token) {
    this.authToken = token;
    return this;
  }
  execute = (placeholderValues) => {
    return this._prepare().execute(placeholderValues, this.authToken);
  };
  /** @internal */
  getSelectedFields() {
    return this.config.returningFields ? new Proxy(
      this.config.returningFields,
      new SelectionProxyHandler({
        alias: getTableName(this.config.table),
        sqlAliasedBehavior: "alias",
        sqlBehavior: "error"
      })
    ) : void 0;
  }
  $dynamic() {
    return this;
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/query-builders/count.js
var PgCountBuilder = class _PgCountBuilder extends SQL {
  constructor(params) {
    super(_PgCountBuilder.buildEmbeddedCount(params.source, params.filters).queryChunks);
    this.params = params;
    this.mapWith(Number);
    this.session = params.session;
    this.sql = _PgCountBuilder.buildCount(
      params.source,
      params.filters
    );
  }
  sql;
  token;
  static [entityKind] = "PgCountBuilder";
  [Symbol.toStringTag] = "PgCountBuilder";
  session;
  static buildEmbeddedCount(source, filters) {
    return sql`(select count(*) from ${source}${sql.raw(" where ").if(filters)}${filters})`;
  }
  static buildCount(source, filters) {
    return sql`select count(*) as count from ${source}${sql.raw(" where ").if(filters)}${filters};`;
  }
  /** @intrnal */
  setToken(token) {
    this.token = token;
    return this;
  }
  then(onfulfilled, onrejected) {
    return Promise.resolve(this.session.count(this.sql, this.token)).then(
      onfulfilled,
      onrejected
    );
  }
  catch(onRejected) {
    return this.then(void 0, onRejected);
  }
  finally(onFinally) {
    return this.then(
      (value) => {
        onFinally?.();
        return value;
      },
      (reason) => {
        onFinally?.();
        throw reason;
      }
    );
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/query-builders/query.js
var RelationalQueryBuilder = class {
  constructor(fullSchema, schema, tableNamesMap, table, tableConfig, dialect, session) {
    this.fullSchema = fullSchema;
    this.schema = schema;
    this.tableNamesMap = tableNamesMap;
    this.table = table;
    this.tableConfig = tableConfig;
    this.dialect = dialect;
    this.session = session;
  }
  static [entityKind] = "PgRelationalQueryBuilder";
  findMany(config) {
    return new PgRelationalQuery(
      this.fullSchema,
      this.schema,
      this.tableNamesMap,
      this.table,
      this.tableConfig,
      this.dialect,
      this.session,
      config ? config : {},
      "many"
    );
  }
  findFirst(config) {
    return new PgRelationalQuery(
      this.fullSchema,
      this.schema,
      this.tableNamesMap,
      this.table,
      this.tableConfig,
      this.dialect,
      this.session,
      config ? { ...config, limit: 1 } : { limit: 1 },
      "first"
    );
  }
};
var PgRelationalQuery = class extends QueryPromise {
  constructor(fullSchema, schema, tableNamesMap, table, tableConfig, dialect, session, config, mode) {
    super();
    this.fullSchema = fullSchema;
    this.schema = schema;
    this.tableNamesMap = tableNamesMap;
    this.table = table;
    this.tableConfig = tableConfig;
    this.dialect = dialect;
    this.session = session;
    this.config = config;
    this.mode = mode;
  }
  static [entityKind] = "PgRelationalQuery";
  /** @internal */
  _prepare(name) {
    return tracer.startActiveSpan("drizzle.prepareQuery", () => {
      const { query, builtQuery } = this._toSQL();
      return this.session.prepareQuery(
        builtQuery,
        void 0,
        name,
        true,
        (rawRows, mapColumnValue) => {
          const rows = rawRows.map(
            (row) => mapRelationalRow(this.schema, this.tableConfig, row, query.selection, mapColumnValue)
          );
          if (this.mode === "first") {
            return rows[0];
          }
          return rows;
        }
      );
    });
  }
  prepare(name) {
    return this._prepare(name);
  }
  _getQuery() {
    return this.dialect.buildRelationalQueryWithoutPK({
      fullSchema: this.fullSchema,
      schema: this.schema,
      tableNamesMap: this.tableNamesMap,
      table: this.table,
      tableConfig: this.tableConfig,
      queryConfig: this.config,
      tableAlias: this.tableConfig.tsName
    });
  }
  /** @internal */
  getSQL() {
    return this._getQuery().sql;
  }
  _toSQL() {
    const query = this._getQuery();
    const builtQuery = this.dialect.sqlToQuery(query.sql);
    return { query, builtQuery };
  }
  toSQL() {
    return this._toSQL().builtQuery;
  }
  authToken;
  /** @internal */
  setToken(token) {
    this.authToken = token;
    return this;
  }
  execute() {
    return tracer.startActiveSpan("drizzle.operation", () => {
      return this._prepare().execute(void 0, this.authToken);
    });
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/query-builders/raw.js
var PgRaw = class extends QueryPromise {
  constructor(execute, sql2, query, mapBatchResult) {
    super();
    this.execute = execute;
    this.sql = sql2;
    this.query = query;
    this.mapBatchResult = mapBatchResult;
  }
  static [entityKind] = "PgRaw";
  /** @internal */
  getSQL() {
    return this.sql;
  }
  getQuery() {
    return this.query;
  }
  mapResult(result, isFromBatch) {
    return isFromBatch ? this.mapBatchResult(result) : result;
  }
  _prepare() {
    return this;
  }
  /** @internal */
  isResponseInArrayMode() {
    return false;
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/db.js
var PgDatabase = class {
  constructor(dialect, session, schema) {
    this.dialect = dialect;
    this.session = session;
    this._ = schema ? {
      schema: schema.schema,
      fullSchema: schema.fullSchema,
      tableNamesMap: schema.tableNamesMap,
      session
    } : {
      schema: void 0,
      fullSchema: {},
      tableNamesMap: {},
      session
    };
    this.query = {};
    if (this._.schema) {
      for (const [tableName, columns] of Object.entries(this._.schema)) {
        this.query[tableName] = new RelationalQueryBuilder(
          schema.fullSchema,
          this._.schema,
          this._.tableNamesMap,
          schema.fullSchema[tableName],
          columns,
          dialect,
          session
        );
      }
    }
    this.$cache = { invalidate: async (_params) => {
    } };
  }
  static [entityKind] = "PgDatabase";
  query;
  /**
   * Creates a subquery that defines a temporary named result set as a CTE.
   *
   * It is useful for breaking down complex queries into simpler parts and for reusing the result set in subsequent parts of the query.
   *
   * See docs: {@link https://orm.drizzle.team/docs/select#with-clause}
   *
   * @param alias The alias for the subquery.
   *
   * Failure to provide an alias will result in a DrizzleTypeError, preventing the subquery from being referenced in other queries.
   *
   * @example
   *
   * ```ts
   * // Create a subquery with alias 'sq' and use it in the select query
   * const sq = db.$with('sq').as(db.select().from(users).where(eq(users.id, 42)));
   *
   * const result = await db.with(sq).select().from(sq);
   * ```
   *
   * To select arbitrary SQL values as fields in a CTE and reference them in other CTEs or in the main query, you need to add aliases to them:
   *
   * ```ts
   * // Select an arbitrary SQL value as a field in a CTE and reference it in the main query
   * const sq = db.$with('sq').as(db.select({
   *   name: sql<string>`upper(${users.name})`.as('name'),
   * })
   * .from(users));
   *
   * const result = await db.with(sq).select({ name: sq.name }).from(sq);
   * ```
   */
  $with = (alias, selection) => {
    const self = this;
    const as = (qb) => {
      if (typeof qb === "function") {
        qb = qb(new QueryBuilder(self.dialect));
      }
      return new Proxy(
        new WithSubquery(
          qb.getSQL(),
          selection ?? ("getSelectedFields" in qb ? qb.getSelectedFields() ?? {} : {}),
          alias,
          true
        ),
        new SelectionProxyHandler({ alias, sqlAliasedBehavior: "alias", sqlBehavior: "error" })
      );
    };
    return { as };
  };
  $count(source, filters) {
    return new PgCountBuilder({ source, filters, session: this.session });
  }
  $cache;
  /**
   * Incorporates a previously defined CTE (using `$with`) into the main query.
   *
   * This method allows the main query to reference a temporary named result set.
   *
   * See docs: {@link https://orm.drizzle.team/docs/select#with-clause}
   *
   * @param queries The CTEs to incorporate into the main query.
   *
   * @example
   *
   * ```ts
   * // Define a subquery 'sq' as a CTE using $with
   * const sq = db.$with('sq').as(db.select().from(users).where(eq(users.id, 42)));
   *
   * // Incorporate the CTE 'sq' into the main query and select from it
   * const result = await db.with(sq).select().from(sq);
   * ```
   */
  with(...queries) {
    const self = this;
    function select2(fields) {
      return new PgSelectBuilder({
        fields: fields ?? void 0,
        session: self.session,
        dialect: self.dialect,
        withList: queries
      });
    }
    function selectDistinct(fields) {
      return new PgSelectBuilder({
        fields: fields ?? void 0,
        session: self.session,
        dialect: self.dialect,
        withList: queries,
        distinct: true
      });
    }
    function selectDistinctOn(on, fields) {
      return new PgSelectBuilder({
        fields: fields ?? void 0,
        session: self.session,
        dialect: self.dialect,
        withList: queries,
        distinct: { on }
      });
    }
    function update(table) {
      return new PgUpdateBuilder(table, self.session, self.dialect, queries);
    }
    function insert(table) {
      return new PgInsertBuilder(table, self.session, self.dialect, queries);
    }
    function delete_(table) {
      return new PgDeleteBase(table, self.session, self.dialect, queries);
    }
    return { select: select2, selectDistinct, selectDistinctOn, update, insert, delete: delete_ };
  }
  select(fields) {
    return new PgSelectBuilder({
      fields: fields ?? void 0,
      session: this.session,
      dialect: this.dialect
    });
  }
  selectDistinct(fields) {
    return new PgSelectBuilder({
      fields: fields ?? void 0,
      session: this.session,
      dialect: this.dialect,
      distinct: true
    });
  }
  selectDistinctOn(on, fields) {
    return new PgSelectBuilder({
      fields: fields ?? void 0,
      session: this.session,
      dialect: this.dialect,
      distinct: { on }
    });
  }
  /**
   * Creates an update query.
   *
   * Calling this method without `.where()` clause will update all rows in a table. The `.where()` clause specifies which rows should be updated.
   *
   * Use `.set()` method to specify which values to update.
   *
   * See docs: {@link https://orm.drizzle.team/docs/update}
   *
   * @param table The table to update.
   *
   * @example
   *
   * ```ts
   * // Update all rows in the 'cars' table
   * await db.update(cars).set({ color: 'red' });
   *
   * // Update rows with filters and conditions
   * await db.update(cars).set({ color: 'red' }).where(eq(cars.brand, 'BMW'));
   *
   * // Update with returning clause
   * const updatedCar: Car[] = await db.update(cars)
   *   .set({ color: 'red' })
   *   .where(eq(cars.id, 1))
   *   .returning();
   * ```
   */
  update(table) {
    return new PgUpdateBuilder(table, this.session, this.dialect);
  }
  /**
   * Creates an insert query.
   *
   * Calling this method will create new rows in a table. Use `.values()` method to specify which values to insert.
   *
   * See docs: {@link https://orm.drizzle.team/docs/insert}
   *
   * @param table The table to insert into.
   *
   * @example
   *
   * ```ts
   * // Insert one row
   * await db.insert(cars).values({ brand: 'BMW' });
   *
   * // Insert multiple rows
   * await db.insert(cars).values([{ brand: 'BMW' }, { brand: 'Porsche' }]);
   *
   * // Insert with returning clause
   * const insertedCar: Car[] = await db.insert(cars)
   *   .values({ brand: 'BMW' })
   *   .returning();
   * ```
   */
  insert(table) {
    return new PgInsertBuilder(table, this.session, this.dialect);
  }
  /**
   * Creates a delete query.
   *
   * Calling this method without `.where()` clause will delete all rows in a table. The `.where()` clause specifies which rows should be deleted.
   *
   * See docs: {@link https://orm.drizzle.team/docs/delete}
   *
   * @param table The table to delete from.
   *
   * @example
   *
   * ```ts
   * // Delete all rows in the 'cars' table
   * await db.delete(cars);
   *
   * // Delete rows with filters and conditions
   * await db.delete(cars).where(eq(cars.color, 'green'));
   *
   * // Delete with returning clause
   * const deletedCar: Car[] = await db.delete(cars)
   *   .where(eq(cars.id, 1))
   *   .returning();
   * ```
   */
  delete(table) {
    return new PgDeleteBase(table, this.session, this.dialect);
  }
  refreshMaterializedView(view) {
    return new PgRefreshMaterializedView(view, this.session, this.dialect);
  }
  authToken;
  execute(query) {
    const sequel = typeof query === "string" ? sql.raw(query) : query.getSQL();
    const builtQuery = this.dialect.sqlToQuery(sequel);
    const prepared = this.session.prepareQuery(
      builtQuery,
      void 0,
      void 0,
      false
    );
    return new PgRaw(
      () => prepared.execute(void 0, this.authToken),
      sequel,
      builtQuery,
      (result) => prepared.mapResult(result, true)
    );
  }
  transaction(transaction, config) {
    return this.session.transaction(transaction, config);
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/cache/core/cache.js
var Cache = class {
  static [entityKind] = "Cache";
};
var NoopCache = class extends Cache {
  strategy() {
    return "all";
  }
  static [entityKind] = "NoopCache";
  async get(_key) {
    return void 0;
  }
  async put(_hashedQuery, _response, _tables, _config) {
  }
  async onMutate(_params) {
  }
};
async function hashQuery(sql2, params) {
  const dataToHash = `${sql2}-${JSON.stringify(params)}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(dataToHash);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = [...new Uint8Array(hashBuffer)];
  const hashHex = hashArray.map((b2) => b2.toString(16).padStart(2, "0")).join("");
  return hashHex;
}

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/pg-core/session.js
var PgPreparedQuery = class {
  constructor(query, cache, queryMetadata, cacheConfig) {
    this.query = query;
    this.cache = cache;
    this.queryMetadata = queryMetadata;
    this.cacheConfig = cacheConfig;
    if (cache && cache.strategy() === "all" && cacheConfig === void 0) {
      this.cacheConfig = { enable: true, autoInvalidate: true };
    }
    if (!this.cacheConfig?.enable) {
      this.cacheConfig = void 0;
    }
  }
  authToken;
  getQuery() {
    return this.query;
  }
  mapResult(response, _isFromBatch) {
    return response;
  }
  /** @internal */
  setToken(token) {
    this.authToken = token;
    return this;
  }
  static [entityKind] = "PgPreparedQuery";
  /** @internal */
  joinsNotNullableMap;
  /** @internal */
  async queryWithCache(queryString, params, query) {
    if (this.cache === void 0 || is(this.cache, NoopCache) || this.queryMetadata === void 0) {
      try {
        return await query();
      } catch (e) {
        throw new DrizzleQueryError(queryString, params, e);
      }
    }
    if (this.cacheConfig && !this.cacheConfig.enable) {
      try {
        return await query();
      } catch (e) {
        throw new DrizzleQueryError(queryString, params, e);
      }
    }
    if ((this.queryMetadata.type === "insert" || this.queryMetadata.type === "update" || this.queryMetadata.type === "delete") && this.queryMetadata.tables.length > 0) {
      try {
        const [res] = await Promise.all([
          query(),
          this.cache.onMutate({ tables: this.queryMetadata.tables })
        ]);
        return res;
      } catch (e) {
        throw new DrizzleQueryError(queryString, params, e);
      }
    }
    if (!this.cacheConfig) {
      try {
        return await query();
      } catch (e) {
        throw new DrizzleQueryError(queryString, params, e);
      }
    }
    if (this.queryMetadata.type === "select") {
      const fromCache = await this.cache.get(
        this.cacheConfig.tag ?? await hashQuery(queryString, params),
        this.queryMetadata.tables,
        this.cacheConfig.tag !== void 0,
        this.cacheConfig.autoInvalidate
      );
      if (fromCache === void 0) {
        let result;
        try {
          result = await query();
        } catch (e) {
          throw new DrizzleQueryError(queryString, params, e);
        }
        await this.cache.put(
          this.cacheConfig.tag ?? await hashQuery(queryString, params),
          result,
          // make sure we send tables that were used in a query only if user wants to invalidate it on each write
          this.cacheConfig.autoInvalidate ? this.queryMetadata.tables : [],
          this.cacheConfig.tag !== void 0,
          this.cacheConfig.config
        );
        return result;
      }
      return fromCache;
    }
    try {
      return await query();
    } catch (e) {
      throw new DrizzleQueryError(queryString, params, e);
    }
  }
};
var PgSession = class {
  constructor(dialect) {
    this.dialect = dialect;
  }
  static [entityKind] = "PgSession";
  /** @internal */
  execute(query, token) {
    return tracer.startActiveSpan("drizzle.operation", () => {
      const prepared = tracer.startActiveSpan("drizzle.prepareQuery", () => {
        return this.prepareQuery(
          this.dialect.sqlToQuery(query),
          void 0,
          void 0,
          false
        );
      });
      return prepared.setToken(token).execute(void 0, token);
    });
  }
  all(query) {
    return this.prepareQuery(
      this.dialect.sqlToQuery(query),
      void 0,
      void 0,
      false
    ).all();
  }
  /** @internal */
  async count(sql2, token) {
    const res = await this.execute(sql2, token);
    return Number(
      res[0]["count"]
    );
  }
};
var PgTransaction = class extends PgDatabase {
  constructor(dialect, session, schema, nestedIndex = 0) {
    super(dialect, session, schema);
    this.schema = schema;
    this.nestedIndex = nestedIndex;
  }
  static [entityKind] = "PgTransaction";
  rollback() {
    throw new TransactionRollbackError();
  }
  /** @internal */
  getTransactionConfigSQL(config) {
    const chunks = [];
    if (config.isolationLevel) {
      chunks.push(`isolation level ${config.isolationLevel}`);
    }
    if (config.accessMode) {
      chunks.push(config.accessMode);
    }
    if (typeof config.deferrable === "boolean") {
      chunks.push(config.deferrable ? "deferrable" : "not deferrable");
    }
    return sql.raw(chunks.join(" "));
  }
  setTransaction(config) {
    return this.session.execute(sql`set transaction ${this.getTransactionConfigSQL(config)}`);
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/postgres-js/session.js
var PostgresJsPreparedQuery = class extends PgPreparedQuery {
  constructor(client, queryString, params, logger, cache, queryMetadata, cacheConfig, fields, _isResponseInArrayMode, customResultMapper) {
    super({ sql: queryString, params }, cache, queryMetadata, cacheConfig);
    this.client = client;
    this.queryString = queryString;
    this.params = params;
    this.logger = logger;
    this.fields = fields;
    this._isResponseInArrayMode = _isResponseInArrayMode;
    this.customResultMapper = customResultMapper;
  }
  static [entityKind] = "PostgresJsPreparedQuery";
  async execute(placeholderValues = {}) {
    return tracer.startActiveSpan("drizzle.execute", async (span) => {
      const params = fillPlaceholders(this.params, placeholderValues);
      span?.setAttributes({
        "drizzle.query.text": this.queryString,
        "drizzle.query.params": JSON.stringify(params)
      });
      this.logger.logQuery(this.queryString, params);
      const { fields, queryString: query, client, joinsNotNullableMap, customResultMapper } = this;
      if (!fields && !customResultMapper) {
        return tracer.startActiveSpan("drizzle.driver.execute", () => {
          return this.queryWithCache(query, params, async () => {
            return await client.unsafe(query, params);
          });
        });
      }
      const rows = await tracer.startActiveSpan("drizzle.driver.execute", () => {
        span?.setAttributes({
          "drizzle.query.text": query,
          "drizzle.query.params": JSON.stringify(params)
        });
        return this.queryWithCache(query, params, async () => {
          return await client.unsafe(query, params).values();
        });
      });
      return tracer.startActiveSpan("drizzle.mapResponse", () => {
        return customResultMapper ? customResultMapper(rows) : rows.map((row) => mapResultRow(fields, row, joinsNotNullableMap));
      });
    });
  }
  all(placeholderValues = {}) {
    return tracer.startActiveSpan("drizzle.execute", async (span) => {
      const params = fillPlaceholders(this.params, placeholderValues);
      span?.setAttributes({
        "drizzle.query.text": this.queryString,
        "drizzle.query.params": JSON.stringify(params)
      });
      this.logger.logQuery(this.queryString, params);
      return tracer.startActiveSpan("drizzle.driver.execute", () => {
        span?.setAttributes({
          "drizzle.query.text": this.queryString,
          "drizzle.query.params": JSON.stringify(params)
        });
        return this.queryWithCache(this.queryString, params, async () => {
          return this.client.unsafe(this.queryString, params);
        });
      });
    });
  }
  /** @internal */
  isResponseInArrayMode() {
    return this._isResponseInArrayMode;
  }
};
var PostgresJsSession = class _PostgresJsSession extends PgSession {
  constructor(client, dialect, schema, options = {}) {
    super(dialect);
    this.client = client;
    this.schema = schema;
    this.options = options;
    this.logger = options.logger ?? new NoopLogger();
    this.cache = options.cache ?? new NoopCache();
  }
  static [entityKind] = "PostgresJsSession";
  logger;
  cache;
  prepareQuery(query, fields, name, isResponseInArrayMode, customResultMapper, queryMetadata, cacheConfig) {
    return new PostgresJsPreparedQuery(
      this.client,
      query.sql,
      query.params,
      this.logger,
      this.cache,
      queryMetadata,
      cacheConfig,
      fields,
      isResponseInArrayMode,
      customResultMapper
    );
  }
  query(query, params) {
    this.logger.logQuery(query, params);
    return this.client.unsafe(query, params).values();
  }
  queryObjects(query, params) {
    return this.client.unsafe(query, params);
  }
  transaction(transaction, config) {
    return this.client.begin(async (client) => {
      const session = new _PostgresJsSession(
        client,
        this.dialect,
        this.schema,
        this.options
      );
      const tx = new PostgresJsTransaction(this.dialect, session, this.schema);
      if (config) {
        await tx.setTransaction(config);
      }
      return transaction(tx);
    });
  }
};
var PostgresJsTransaction = class _PostgresJsTransaction extends PgTransaction {
  constructor(dialect, session, schema, nestedIndex = 0) {
    super(dialect, session, schema, nestedIndex);
    this.session = session;
  }
  static [entityKind] = "PostgresJsTransaction";
  transaction(transaction) {
    return this.session.client.savepoint((client) => {
      const session = new PostgresJsSession(
        client,
        this.dialect,
        this.schema,
        this.session.options
      );
      const tx = new _PostgresJsTransaction(this.dialect, session, this.schema);
      return transaction(tx);
    });
  }
};

// node_modules/.pnpm/drizzle-orm@0.44.7_@electric-sql+pglite@0.5.4_@opentelemetry+api@1.9.1_@types+pg@8.15.6_postgres@3.4.8/node_modules/drizzle-orm/postgres-js/driver.js
var PostgresJsDatabase = class extends PgDatabase {
  static [entityKind] = "PostgresJsDatabase";
};
function construct(client, config = {}) {
  const transparentParser = (val) => val;
  for (const type of ["1184", "1082", "1083", "1114", "1182", "1185", "1115", "1231"]) {
    client.options.parsers[type] = transparentParser;
    client.options.serializers[type] = transparentParser;
  }
  client.options.serializers["114"] = transparentParser;
  client.options.serializers["3802"] = transparentParser;
  const dialect = new PgDialect({ casing: config.casing });
  let logger;
  if (config.logger === true) {
    logger = new DefaultLogger();
  } else if (config.logger !== false) {
    logger = config.logger;
  }
  let schema;
  if (config.schema) {
    const tablesConfig = extractTablesRelationalConfig(
      config.schema,
      createTableRelationsHelpers
    );
    schema = {
      fullSchema: config.schema,
      schema: tablesConfig.tables,
      tableNamesMap: tablesConfig.tableNamesMap
    };
  }
  const session = new PostgresJsSession(client, dialect, schema, { logger, cache: config.cache });
  const db = new PostgresJsDatabase(dialect, session, schema);
  db.$client = client;
  db.$cache = config.cache;
  if (db.$cache) {
    db.$cache["invalidate"] = config.cache?.onMutate;
  }
  return db;
}
function drizzle(...params) {
  if (typeof params[0] === "string") {
    const instance = src_default(params[0]);
    return construct(instance, params[1]);
  }
  if (isConfig(params[0])) {
    const { connection: connection2, client, ...drizzleConfig } = params[0];
    if (client) return construct(client, drizzleConfig);
    if (typeof connection2 === "object" && connection2.url !== void 0) {
      const { url, ...config } = connection2;
      const instance2 = src_default(url, config);
      return construct(instance2, drizzleConfig);
    }
    const instance = src_default(connection2);
    return construct(instance, drizzleConfig);
  }
  return construct(params[0], params[1]);
}
((drizzle2) => {
  function mock(config) {
    return construct({
      options: {
        parsers: {},
        serializers: {}
      }
    }, config);
  }
  drizzle2.mock = mock;
})(drizzle || (drizzle = {}));

// node_modules/.pnpm/nanoid@5.1.7/node_modules/nanoid/index.js
import { webcrypto as crypto3 } from "node:crypto";

// node_modules/.pnpm/nanoid@5.1.7/node_modules/nanoid/url-alphabet/index.js
var urlAlphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

// node_modules/.pnpm/nanoid@5.1.7/node_modules/nanoid/index.js
var POOL_SIZE_MULTIPLIER = 128;
var pool;
var poolOffset;
function fillPool(bytes) {
  if (!pool || pool.length < bytes) {
    pool = Buffer.allocUnsafe(bytes * POOL_SIZE_MULTIPLIER);
    crypto3.getRandomValues(pool);
    poolOffset = 0;
  } else if (poolOffset + bytes > pool.length) {
    crypto3.getRandomValues(pool);
    poolOffset = 0;
  }
  poolOffset += bytes;
}
function nanoid(size2 = 21) {
  fillPool(size2 |= 0);
  let id = "";
  for (let i = poolOffset - size2; i < poolOffset; i++) {
    id += urlAlphabet[pool[i] & 63];
  }
  return id;
}

// src/lib/server/utils/id.ts
function generateId() {
  return nanoid();
}

// src/lib/server/db/schema.ts
var bytea = customType({
  dataType() {
    return "bytea";
  }
});
var platforms = pgTable("platforms", {
  id: text("id").primaryKey().$defaultFn(() => generateId()),
  name: text("name").notNull(),
  ownerId: text("owner_id"),
  // Set after first user is created
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow()
});
var signingKeys = pgTable("signing_keys", {
  id: text("id").primaryKey().$defaultFn(() => generateId()),
  platformId: text("platform_id").notNull().references(() => platforms.id),
  publicKey: text("public_key").notNull(),
  // PEM-encoded RSA public key
  algorithm: text("algorithm").notNull().default("RS256"),
  displayName: text("display_name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow()
});
var users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  // Platform association
  platformId: text("platform_id").references(() => platforms.id),
  platformRole: text("platform_role").default("MEMBER").$type(),
  status: text("status").default("ACTIVE").$type()
});
var userIdentities = pgTable("user_identities", {
  id: text("id").primaryKey().$defaultFn(() => generateId()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  password: text("password"),
  // bcrypt hash, nullable for social-only
  provider: text("provider").notNull().$type(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  tokenVersion: integer("token_version").notNull().default(0),
  verified: boolean("verified").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow()
});
var projects = pgTable("projects", {
  id: text("id").primaryKey().$defaultFn(() => generateId()),
  platformId: text("platform_id").notNull().references(() => platforms.id),
  ownerId: text("owner_id").notNull().references(() => users.id),
  displayName: text("display_name").notNull(),
  externalId: text("external_id").notNull().unique(),
  // AP-compatible external identifier
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow()
});
var projectMembers = pgTable(
  "project_members",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("ADMIN").$type(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    projectUserUnique: unique("uq_project_members_project_user").on(
      table.projectId,
      table.userId
    )
  })
);
var workflows = pgTable("workflows", {
  id: text("id").primaryKey().$defaultFn(() => generateId()),
  name: text("name").notNull(),
  description: text("description"),
  userId: text("user_id").notNull().references(() => users.id),
  // Project scoping (MCP and multi-user parity with Activepieces).
  // Enforced NOT NULL in migration 0040 after backfill; POST /api/workflows
  // stamps this from locals.session.projectId on every insert.
  projectId: text("project_id").notNull().references(() => projects.id, {
    onDelete: "cascade"
  }),
  // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
  nodes: jsonb("nodes").notNull().$type(),
  // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
  edges: jsonb("edges").notNull().$type(),
  specVersion: text("spec_version"),
  // biome-ignore lint/suspicious/noExplicitAny: JSONB type - authoring spec
  spec: jsonb("spec").$type(),
  visibility: text("visibility").notNull().default("private").$type(),
  // Dapr workflow fields
  engineType: text("engine_type").default("dapr").$type(),
  daprWorkflowName: text("dapr_workflow_name"),
  // Registered Dapr workflow name
  daprOrchestratorUrl: text("dapr_orchestrator_url"),
  // URL of the Dapr orchestrator service
  mlflowExperimentId: text("mlflow_experiment_id"),
  mlflowExperimentName: text("mlflow_experiment_name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow()
});
var mcpServers = pgTable(
  "mcp_server",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("DISABLED").$type(),
    // Encrypted at rest using AP-compatible AES-256-CBC via AP_ENCRYPTION_KEY.
    tokenEncrypted: jsonb("token_encrypted").notNull().$type(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    projectUnique: unique("uq_mcp_server_project_id").on(table.projectId),
    projectIdx: index("idx_mcp_server_project_id").on(table.projectId)
  })
);
var mcpRuns = pgTable(
  "mcp_run",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    mcpServerId: text("mcp_server_id").notNull().references(() => mcpServers.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    workflowExecutionId: text("workflow_execution_id").references(
      () => workflowExecutions.id,
      { onDelete: "set null" }
    ),
    daprInstanceId: text("dapr_instance_id"),
    toolName: text("tool_name").notNull(),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - MCP tool args
    input: jsonb("input").notNull().$type(),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - Reply payload
    response: jsonb("response").$type(),
    status: text("status").notNull().$type(),
    respondedAt: timestamp("responded_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    projectIdx: index("idx_mcp_run_project_id").on(table.projectId),
    mcpServerIdx: index("idx_mcp_run_mcp_server_id").on(table.mcpServerId),
    workflowIdx: index("idx_mcp_run_workflow_id").on(table.workflowId),
    workflowExecutionIdx: index("idx_mcp_run_workflow_execution_id").on(
      table.workflowExecutionId
    )
  })
);
var mcpConnections = pgTable(
  "mcp_connection",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull().$type(),
    pieceName: text("piece_name"),
    serverKey: text("server_key"),
    connectionExternalId: text("connection_external_id"),
    displayName: text("display_name").notNull(),
    registryRef: text("registry_ref"),
    serverUrl: text("server_url"),
    status: text("status").notNull().default("DISABLED").$type(),
    lastSyncAt: timestamp("last_sync_at"),
    lastError: text("last_error"),
    metadata: jsonb("metadata").$type(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null"
    }),
    updatedBy: text("updated_by").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    projectIdx: index("idx_mcp_connection_project_id").on(table.projectId),
    projectStatusIdx: index("idx_mcp_connection_project_status").on(
      table.projectId,
      table.status
    ),
    projectSourcePieceUnique: unique(
      "uq_mcp_connection_project_source_piece"
    ).on(table.projectId, table.sourceType, table.pieceName),
    projectSourceServerKeyUnique: unique(
      "uq_mcp_connection_project_source_server_key"
    ).on(table.projectId, table.sourceType, table.serverKey)
  })
);
var pieceMetadata = pgTable(
  "piece_metadata",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    name: text("name").notNull(),
    authors: text("authors").array().notNull().default([]),
    displayName: text("display_name").notNull(),
    logoUrl: text("logo_url").notNull(),
    description: text("description"),
    platformId: text("platform_id"),
    version: text("version").notNull(),
    minimumSupportedRelease: text("minimum_supported_release").notNull(),
    maximumSupportedRelease: text("maximum_supported_release").notNull(),
    auth: jsonb("auth"),
    actions: jsonb("actions").notNull(),
    triggers: jsonb("triggers").notNull(),
    pieceType: text("piece_type").notNull(),
    categories: text("categories").array().notNull().default([]),
    packageType: text("package_type").notNull(),
    i18n: jsonb("i18n"),
    catalogSchemaVersion: integer("catalog_schema_version"),
    catalogDigest: text("catalog_digest"),
    catalogSourceImage: text("catalog_source_image"),
    catalogSyncedAt: timestamp("catalog_synced_at"),
    // Phase 2 (docs/activepieces-catalog-expansion.md): a row is metadata-only
    // (the piece is in the AP catalog but NOT bundled in piece-mcp-server) — it
    // shows as an "Available — request enablement" option but is NEVER provisioned
    // (no code → would CrashLoop). Bundle-synced rows are always false; the
    // reconciler name-excludes available_only=true pieces. enabled-and-runnable ⊆ bundled.
    availableOnly: boolean("available_only").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    nameVersionPlatformIdx: uniqueIndex(
      "idx_piece_metadata_name_platform_id_version"
    ).on(table.name, table.version, table.platformId),
    catalogDigestIdx: index("idx_piece_metadata_catalog_digest").on(
      table.catalogDigest
    )
  })
);
var appConnections = pgTable(
  "app_connection",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    displayName: text("display_name").notNull(),
    externalId: text("external_id").notNull(),
    type: text("type").notNull().$type(),
    status: text("status").notNull().default("ACTIVE" /* ACTIVE */).$type(),
    platformId: text("platform_id"),
    pieceName: text("piece_name").notNull(),
    ownerId: text("owner_id").references(() => users.id, {
      onDelete: "set null"
    }),
    projectIds: jsonb("project_ids").notNull().$type().default([]),
    scope: text("scope").notNull().default("PROJECT" /* PROJECT */).$type(),
    value: jsonb("value").notNull().$type(),
    metadata: jsonb("metadata").$type(),
    pieceVersion: text("piece_version").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    platformExternalIdIdx: index(
      "idx_app_connection_platform_id_and_external_id"
    ).on(table.platformId, table.externalId),
    ownerIdIdx: index("idx_app_connection_owner_id").on(table.ownerId)
  })
);
var workflowConnectionRefs = pgTable(
  "workflow_connection_ref",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    workflowId: text("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    connectionExternalId: text("connection_external_id").notNull(),
    pieceName: text("piece_name").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    workflowNodeIdx: index("idx_workflow_connection_ref_workflow_node").on(
      table.workflowId,
      table.nodeId
    ),
    workflowExternalIdIdx: index(
      "idx_workflow_connection_ref_workflow_external_id"
    ).on(table.workflowId, table.connectionExternalId)
  })
);
var pieceExecution = pgTable(
  "piece_execution",
  {
    // Deterministic, orchestrator-supplied — no default.
    idempotencyKey: text("idempotency_key").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    executionId: text("execution_id").notNull(),
    dbExecutionId: text("db_execution_id"),
    nodeId: text("node_id").notNull(),
    pieceName: text("piece_name").notNull(),
    actionName: text("action_name").notNull(),
    pieceVersion: text("piece_version"),
    connectionExternalId: text("connection_external_id"),
    // 'paused' is not a cacheable terminal state — a RESUME re-invocation
    // must re-execute, so the gate only short-circuits completed/permanent.
    status: text("status").notNull().$type(),
    attempt: integer("attempt").notNull().default(1),
    result: jsonb("result"),
    error: text("error"),
    errorClass: text("error_class").$type(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    workflowIdx: index("idx_piece_execution_workflow").on(table.workflowId),
    dbExecutionIdx: index("idx_piece_execution_db_execution").on(
      table.dbExecutionId
    )
  })
);
var pieceStore = pgTable(
  "piece_store",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    value: jsonb("value"),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.scope, table.key] })
  })
);
var workflowExecutions = pgTable(
  "workflow_executions",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    workflowId: text("workflow_id").notNull().references(() => workflows.id),
    userId: text("user_id").notNull().references(() => users.id),
    // CMA alignment: scope executions by workspace/project. Backfilled from
    // workflows.project_id in migration 0035; nullable for pre-CMA rows.
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null"
    }),
    status: text("status").notNull().$type(),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
    input: jsonb("input").$type(),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
    output: jsonb("output").$type(),
    executionIrVersion: text("execution_ir_version"),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - immutable execution contract snapshot
    executionIr: jsonb("execution_ir").$type(),
    error: text("error"),
    // Dapr execution fields
    daprInstanceId: text("dapr_instance_id"),
    // Dapr workflow instance ID for correlation
    phase: text("phase"),
    // Current phase from Dapr custom status
    progress: integer("progress"),
    // 0-100 progress percentage
    currentNodeId: text("current_node_id"),
    currentNodeName: text("current_node_name"),
    primaryTraceId: text("primary_trace_id"),
    workflowSessionId: text("workflow_session_id"),
    mlflowExperimentId: text("mlflow_experiment_id"),
    mlflowRunId: text("mlflow_run_id"),
    summaryOutput: jsonb("summary_output").$type(),
    errorStackTrace: text("error_stack_trace"),
    rerunOfExecutionId: text("rerun_of_execution_id"),
    rerunSourceInstanceId: text("rerun_source_instance_id"),
    // Resume/fork: the top-level node this run was forked FROM (skip-prefix point).
    // NULL for normal (non-fork) runs. Drives the fork-lineage tree's "fork @<node>"
    // labels so each branch shows where it diverged.
    resumeFromNode: text("resume_from_node"),
    // Set when this run was started by the event-driven trigger spine (to the
    // firing trigger's id/kind). NULL for manual/API runs. Drives the triggered-
    // run concurrency gate + the "pending/active triggered runs" capacity lens.
    triggerSource: text("trigger_source"),
    rerunFromEventId: integer("rerun_from_event_id"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
    duration: text("duration"),
    // Duration in milliseconds
    // Lifecycle stop-intent: set by stopDurableRun the moment a stop is
    // requested. Decouples "termination requested" from "confirmed terminal" —
    // the row stays non-terminal until the cascade or the terminal-status
    // reaper confirms the durable tree is closed, then finalizeDb flips status.
    stopRequestedAt: timestamp("stop_requested_at"),
    stopReason: text("stop_reason")
  },
  (table) => ({
    workflowStartedIdx: index("idx_workflow_executions_workflow_started").on(
      table.workflowId,
      table.startedAt
    ),
    statusStartedIdx: index("idx_workflow_executions_status_started").on(
      table.status,
      table.startedAt
    ),
    daprInstanceIdx: index("idx_workflow_executions_dapr_instance").on(
      table.daprInstanceId
    ),
    sessionIdx: index("idx_workflow_executions_session").on(
      table.workflowSessionId
    ),
    mlflowRunIdx: index("idx_workflow_executions_mlflow_run").on(
      table.mlflowRunId
    ),
    projectIdx: index("idx_workflow_executions_project_id").on(table.projectId),
    // Active-triggered-run count (concurrency gate + capacity lens).
    triggerSourceStatusIdx: index(
      "idx_workflow_executions_trigger_source_status"
    ).on(table.triggerSource, table.status),
    rerunOfExecutionFk: foreignKey({
      columns: [table.rerunOfExecutionId],
      foreignColumns: [table.id],
      name: "workflow_executions_rerun_of_execution_id_workflow_executions_id_fk"
    }).onDelete("set null")
  })
);
var workflowScriptCalls = pgTable(
  "workflow_script_calls",
  {
    workflowExecutionId: text("workflow_execution_id").notNull().references(() => workflowExecutions.id, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull().default("agent"),
    baseHash: text("base_hash"),
    occurrence: integer("occurrence").notNull().default(0),
    label: text("label"),
    phase: text("phase"),
    promptSha256: text("prompt_sha256"),
    status: text("status").notNull(),
    sessionId: text("session_id"),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - parsed agent output
    result: jsonb("result").$type(),
    errorCode: text("error_code"),
    retries: integer("retries").notNull().default(0),
    tokensUsed: integer("tokens_used").notNull().default(0),
    // Advisory call-site {line, column} in stored-source coordinates (contract
    // 1.2.0, cutover P2): the static-graph <-> journal join key for the canvas
    // overlay. NEVER part of callId identity; stale after resume-after-edit
    // imports (the overlay falls back to label/phase heuristics then).
    callSite: jsonb("call_site").$type(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workflowExecutionId, table.callId] })
  })
);
var workflowTriggers = pgTable(
  "workflow_triggers",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    workflowId: text("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade"
    }),
    // Registry kind id (webhook | schedule | topic | queue | github | resource | …).
    kind: text("kind").notNull(),
    // Per-kind config (validated against the kind's configSchema).
    config: jsonb("config").$type().notNull().default({}),
    // Static defaults merged into every fired run's triggerData.
    triggerData: jsonb("trigger_data").$type(),
    // Salt for the deterministic per-fire dedup/execution id.
    dedupSalt: text("dedup_salt").notNull(),
    // Opaque handle to the provisioned backing resource (job id / sensor name / …).
    backingRef: text("backing_ref"),
    status: text("status").$type().notNull().default("inactive"),
    lastError: text("last_error"),
    lastFiredAt: timestamp("last_fired_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    workflowStatusIdx: index("idx_workflow_triggers_workflow_status").on(
      table.workflowId,
      table.status
    ),
    kindIdx: index("idx_workflow_triggers_kind").on(table.kind)
  })
);
var workflowPlanArtifacts = pgTable(
  "workflow_plan_artifacts",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    workflowExecutionId: text("workflow_execution_id").notNull().references(() => workflowExecutions.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    nodeId: text("node_id").notNull(),
    workspaceRef: text("workspace_ref"),
    clonePath: text("clone_path"),
    artifactType: text("artifact_type").notNull().default("claude_task_graph_v1").$type(),
    artifactVersion: integer("artifact_version").notNull().default(1),
    status: text("status").notNull().default("draft").$type(),
    goal: text("goal").notNull(),
    // biome-ignore lint/suspicious/noExplicitAny: Structured plan JSON schema versioned at runtime
    planJson: jsonb("plan_json").notNull().$type(),
    planMarkdown: text("plan_markdown"),
    sourcePrompt: text("source_prompt"),
    metadata: jsonb("metadata").$type(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    executionCreatedIdx: index(
      "idx_workflow_plan_artifacts_execution_created"
    ).on(table.workflowExecutionId, table.createdAt),
    workflowNodeCreatedIdx: index(
      "idx_workflow_plan_artifacts_workflow_node_created"
    ).on(table.workflowId, table.nodeId, table.createdAt),
    statusIdx: index("idx_workflow_plan_artifacts_status").on(table.status),
    userCreatedIdx: index("idx_workflow_plan_artifacts_user_created").on(
      table.userId,
      table.createdAt
    )
  })
);
var workflowBrowserArtifacts = pgTable(
  "workflow_browser_artifacts",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    workflowExecutionId: text("workflow_execution_id").notNull().references(() => workflowExecutions.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    workspaceRef: text("workspace_ref"),
    artifactType: text("artifact_type").notNull().default("capture_flow_v1").$type(),
    artifactVersion: integer("artifact_version").notNull().default(1),
    status: text("status").notNull().default("pending").$type(),
    manifestJson: jsonb("manifest_json").notNull().$type(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    executionCreatedIdx: index(
      "idx_workflow_browser_artifacts_execution_created"
    ).on(table.workflowExecutionId, table.createdAt),
    workflowNodeCreatedIdx: index(
      "idx_workflow_browser_artifacts_workflow_node_created"
    ).on(table.workflowId, table.nodeId, table.createdAt),
    statusIdx: index("idx_workflow_browser_artifacts_status").on(table.status)
  })
);
var workflowBrowserArtifactBlobPayloads = pgTable(
  "workflow_browser_artifact_blob_payloads",
  {
    storageRef: text("storage_ref").primaryKey(),
    payloadText: text("payload_text").notNull(),
    contentType: text("content_type").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow()
  }
);
var files = pgTable(
  "files",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade"
    }),
    name: text("name").notNull(),
    purpose: text("purpose").notNull().$type(),
    scopeId: text("scope_id"),
    contentType: text("content_type"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    storageRef: text("storage_ref").notNull(),
    sha1: text("sha1"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    archivedAt: timestamp("archived_at")
  },
  (table) => ({
    userIdx: index("idx_files_user").on(table.userId),
    scopeIdx: index("idx_files_scope").on(table.scopeId),
    purposeIdx: index("idx_files_purpose").on(table.purpose),
    createdIdx: index("idx_files_created").on(table.createdAt),
    scopeNameSha1Idx: index("idx_files_scope_name_sha1").on(
      table.scopeId,
      table.name,
      table.sha1
    )
  })
);
var filePayloads = pgTable("file_payloads", {
  storageRef: text("storage_ref").primaryKey(),
  payloadBytes: bytea("payload_bytes").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow()
});
var workflowArtifacts = pgTable(
  "workflow_artifacts",
  {
    id: text("id").primaryKey(),
    workflowExecutionId: text("workflow_execution_id").notNull().references(() => workflowExecutions.id, { onDelete: "cascade" }),
    nodeId: text("node_id"),
    slot: text("slot").$type(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    inlinePayload: jsonb("inline_payload"),
    fileId: text("file_id").references(() => files.id, {
      onDelete: "set null"
    }),
    contentType: text("content_type"),
    sizeBytes: integer("size_bytes"),
    metadata: jsonb("metadata").$type(),
    createdAt: timestamp("created_at").notNull().defaultNow()
  },
  (table) => ({
    executionCreatedIdx: index("idx_workflow_artifacts_execution_created").on(
      table.workflowExecutionId,
      table.createdAt
    ),
    executionKindIdx: index("idx_workflow_artifacts_execution_kind").on(
      table.workflowExecutionId,
      table.kind
    ),
    executionSlotIdx: index("idx_workflow_artifacts_execution_slot").on(
      table.workflowExecutionId,
      table.slot
    )
  })
);
var previewControlArtifacts = pgTable(
  "preview_control_artifacts",
  {
    id: text("id").primaryKey(),
    previewName: text("preview_name").notNull(),
    environmentRequestId: text("environment_request_id").notNull(),
    executionId: text("execution_id").notNull(),
    sourceArtifactId: text("source_artifact_id").notNull(),
    fileId: text("file_id").notNull().references(() => files.id, { onDelete: "restrict" }),
    fileDigest: text("file_digest").notNull(),
    artifactSnapshot: jsonb("artifact_snapshot").notNull(),
    platformRevision: text("platform_revision").notNull(),
    sourceRevision: text("source_revision").notNull(),
    catalogDigest: text("catalog_digest").notNull(),
    services: jsonb("services").$type().notNull(),
    captureId: text("capture_id").notNull(),
    generation: text("generation").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow()
  },
  (table) => ({
    sourceIdentity: uniqueIndex(
      "uq_preview_control_artifact_source_identity"
    ).on(
      table.previewName,
      table.environmentRequestId,
      table.executionId,
      table.sourceArtifactId
    ),
    requestIdx: index("idx_preview_control_artifact_request").on(
      table.previewName,
      table.environmentRequestId
    )
  })
);
var previewSourcePromotionReceipts = pgTable(
  "preview_source_promotion_receipts",
  {
    receiptId: text("receipt_id").primaryKey(),
    artifactId: text("artifact_id").notNull().references(() => previewControlArtifacts.id, { onDelete: "restrict" }),
    previewName: text("preview_name").notNull(),
    environmentRequestId: text("environment_request_id").notNull(),
    executionId: text("execution_id").notNull(),
    platformRevision: text("platform_revision").notNull(),
    sourceRevision: text("source_revision").notNull(),
    catalogDigest: text("catalog_digest").notNull(),
    repository: text("repository").notNull(),
    baseBranch: text("base_branch").notNull(),
    baseSha: text("base_sha").notNull(),
    branch: text("branch").notNull(),
    commitSha: text("commit_sha").notNull(),
    prUrl: text("pr_url").notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),
    draft: boolean("draft").notNull(),
    services: jsonb("services").$type().notNull(),
    changedPaths: jsonb("changed_paths").$type().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow()
  },
  (table) => ({
    artifactIdentity: uniqueIndex(
      "uq_preview_source_promotion_receipt_artifact"
    ).on(table.artifactId),
    sessionCreatedIdx: index(
      "idx_preview_source_promotion_receipt_session_created"
    ).on(
      table.previewName,
      table.environmentRequestId,
      table.executionId,
      table.createdAt
    ),
    prHeadIdx: index("idx_preview_source_promotion_receipt_pr_head").on(
      table.repository,
      table.pullRequestNumber,
      table.commitSha
    )
  })
);
var previewAcceptedImageReceipts = pgTable(
  "preview_accepted_image_receipts",
  {
    receiptDigest: text("receipt_digest").primaryKey(),
    repository: text("repository").notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),
    baseSha: text("base_sha").notNull(),
    headSha: text("head_sha").notNull(),
    catalogDigest: text("catalog_digest").notNull(),
    context: text("context").notNull(),
    attestation: text("attestation").notNull(),
    subjects: jsonb("subjects").$type().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow()
  },
  (table) => ({
    tupleContext: uniqueIndex(
      "uq_preview_accepted_image_receipt_tuple_context"
    ).on(
      table.repository,
      table.pullRequestNumber,
      table.baseSha,
      table.headSha,
      table.context
    ),
    headContextIdx: index("idx_preview_accepted_image_receipt_head_context").on(
      table.repository,
      table.headSha,
      table.context
    )
  })
);
var previewRuntimeBudgets = pgTable(
  "preview_runtime_budgets",
  {
    previewName: text("preview_name").notNull(),
    environmentRequestId: text("environment_request_id").notNull(),
    platformRevision: text("platform_revision").notNull(),
    sourceRevision: text("source_revision").notNull(),
    catalogDigest: text("catalog_digest").notNull(),
    minuteStartedAt: timestamp("minute_started_at", {
      withTimezone: true
    }).notNull(),
    minuteRequests: integer("minute_requests").notNull(),
    minuteReservedTokens: integer("minute_reserved_tokens").notNull(),
    totalRequests: integer("total_requests").notNull(),
    totalReservedTokens: integer("total_reserved_tokens").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    deleteAfter: timestamp("delete_after", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    identity: primaryKey({
      name: "pk_preview_runtime_budgets_identity",
      columns: [
        table.previewName,
        table.environmentRequestId,
        table.platformRevision,
        table.sourceRevision,
        table.catalogDigest
      ]
    }),
    updatedIdx: index("idx_preview_runtime_budgets_updated_at").on(
      table.updatedAt
    )
  })
);
var workflowWorkspaceSessions = pgTable(
  "workflow_workspace_sessions",
  {
    workspaceRef: text("workspace_ref").primaryKey(),
    // UI sessions have no workflow execution — column is nullable.
    workflowExecutionId: text("workflow_execution_id").references(
      () => workflowExecutions.id,
      { onDelete: "cascade" }
    ),
    durableInstanceId: text("durable_instance_id"),
    name: text("name").notNull(),
    rootPath: text("root_path").notNull(),
    clonePath: text("clone_path"),
    backend: text("backend").notNull().$type(),
    enabledTools: jsonb("enabled_tools").notNull().$type(),
    requireReadBeforeWrite: boolean("require_read_before_write").notNull().default(false),
    commandTimeoutMs: integer("command_timeout_ms").notNull().default(3e4),
    status: text("status").notNull().default("active").$type(),
    lastError: text("last_error"),
    sandboxState: jsonb("sandbox_state").$type(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    lastAccessedAt: timestamp("last_accessed_at").notNull().defaultNow(),
    cleanedAt: timestamp("cleaned_at")
  },
  (table) => ({
    executionIdx: index("idx_workflow_workspace_sessions_execution").on(
      table.workflowExecutionId
    ),
    instanceIdx: index("idx_workflow_workspace_sessions_instance").on(
      table.durableInstanceId
    ),
    statusIdx: index("idx_workflow_workspace_sessions_status").on(table.status)
  })
);
var workflowAgentRuns = pgTable(
  "workflow_agent_runs",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    workflowExecutionId: text("workflow_execution_id").notNull().references(() => workflowExecutions.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    mode: text("mode").notNull().$type(),
    agentWorkflowId: text("agent_workflow_id").notNull(),
    daprInstanceId: text("dapr_instance_id").notNull(),
    parentExecutionId: text("parent_execution_id").notNull(),
    workspaceRef: text("workspace_ref"),
    artifactRef: text("artifact_ref"),
    status: text("status").notNull().default("scheduled").$type(),
    result: jsonb("result").$type(),
    error: text("error"),
    completedAt: timestamp("completed_at"),
    eventPublishedAt: timestamp("event_published_at"),
    lastReconciledAt: timestamp("last_reconciled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    instanceUnique: unique("uq_workflow_agent_runs_instance").on(
      table.daprInstanceId
    ),
    agentWorkflowUnique: unique("uq_workflow_agent_runs_agent_workflow").on(
      table.agentWorkflowId
    ),
    executionIdx: index("idx_workflow_agent_runs_execution").on(
      table.workflowExecutionId,
      table.createdAt
    ),
    statusIdx: index("idx_workflow_agent_runs_status").on(
      table.status,
      table.eventPublishedAt
    )
  })
);
var workflowCodeCheckpoints = pgTable(
  "workflow_code_checkpoints",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    workflowExecutionId: text("workflow_execution_id").notNull().references(() => workflowExecutions.id, { onDelete: "cascade" }),
    workflowAgentRunId: text("workflow_agent_run_id").references(
      () => workflowAgentRuns.id,
      { onDelete: "set null" }
    ),
    parentExecutionId: text("parent_execution_id"),
    daprInstanceId: text("dapr_instance_id").notNull(),
    workspaceRef: text("workspace_ref"),
    sandboxName: text("sandbox_name"),
    repoPath: text("repo_path").notNull(),
    nodeId: text("node_id"),
    sourceEventId: text("source_event_id").notNull(),
    seq: integer("seq"),
    toolName: text("tool_name").notNull(),
    checkpointKind: text("checkpoint_kind").notNull().default("tool_mutation").$type(),
    beforeSha: text("before_sha"),
    afterSha: text("after_sha"),
    remoteUrl: text("remote_url"),
    remoteRef: text("remote_ref"),
    remoteStatus: text("remote_status"),
    remoteError: text("remote_error"),
    remotePushedAt: timestamp("remote_pushed_at"),
    changedFiles: jsonb("changed_files").notNull().$type(),
    fileCount: integer("file_count").notNull().default(0),
    status: text("status").notNull().$type(),
    error: text("error"),
    metadata: jsonb("metadata").$type(),
    createdAt: timestamp("created_at").notNull().defaultNow()
  },
  (table) => ({
    eventUnique: unique("uq_workflow_code_checkpoints_event").on(
      table.workflowExecutionId,
      table.daprInstanceId,
      table.sourceEventId,
      table.checkpointKind
    ),
    executionSeqIdx: index("idx_workflow_code_checkpoints_execution_seq").on(
      table.workflowExecutionId,
      table.seq
    ),
    agentRunSeqIdx: index("idx_workflow_code_checkpoints_agent_run_seq").on(
      table.workflowAgentRunId,
      table.seq
    ),
    workspaceCreatedIdx: index(
      "idx_workflow_code_checkpoints_workspace_created"
    ).on(table.workspaceRef, table.createdAt),
    afterShaIdx: index("idx_workflow_code_checkpoints_after_sha").on(
      table.afterSha
    ),
    remoteRefIdx: index("idx_workflow_code_checkpoints_remote_ref").on(
      table.remoteRef
    )
  })
);
var workflowAiMessages = pgTable(
  "workflow_ai_messages",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    workflowId: text("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().$type(),
    content: text("content").notNull(),
    operations: jsonb("operations").$type(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    workflowCreatedIdx: index("idx_workflow_ai_messages_workflow_created").on(
      table.workflowId,
      table.createdAt
    ),
    userCreatedIdx: index("idx_workflow_ai_messages_user_created").on(
      table.userId,
      table.createdAt
    )
  })
);
var workflowAiToolMessages = pgTable(
  "workflow_ai_tool_messages",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    workflowId: text("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    role: text("role").notNull().$type(),
    parts: jsonb("parts").notNull().$type(),
    textContent: text("text_content").notNull().default(""),
    mentions: jsonb("mentions").$type(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    workflowUserCreatedIdx: index(
      "idx_workflow_ai_tool_messages_workflow_user_created"
    ).on(table.workflowId, table.userId, table.createdAt),
    workflowUserMessageUnique: unique(
      "uq_workflow_ai_tool_messages_workflow_user_message"
    ).on(table.workflowId, table.userId, table.messageId)
  })
);
var workflowExecutionLogs = pgTable(
  "workflow_execution_logs",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    executionId: text("execution_id").notNull().references(() => workflowExecutions.id),
    nodeId: text("node_id").notNull(),
    nodeName: text("node_name").notNull(),
    nodeType: text("node_type").notNull(),
    activityName: text("activity_name"),
    // Function slug (actionType) like "openai/generate-text"
    status: text("status").notNull().$type(),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
    input: jsonb("input").$type(),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
    output: jsonb("output").$type(),
    error: text("error"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
    duration: text("duration"),
    // Duration in milliseconds
    timestamp: timestamp("timestamp").notNull().defaultNow(),
    // Timing breakdown columns (Phase 5 enhancement)
    credentialFetchMs: integer("credential_fetch_ms"),
    routingMs: integer("routing_ms"),
    coldStartMs: integer("cold_start_ms"),
    executionMs: integer("execution_ms"),
    routedTo: text("routed_to"),
    // Service that handled execution (e.g., "fn-openai")
    wasColdStart: boolean("was_cold_start")
  },
  (table) => ({
    executionStartedIdx: index(
      "idx_workflow_execution_logs_execution_started"
    ).on(table.executionId, table.startedAt),
    executionNodeIdx: index("idx_workflow_execution_logs_execution_node").on(
      table.executionId,
      table.nodeId
    )
  })
);
var credentialAccessLogs = pgTable("credential_access_logs", {
  id: text("id").primaryKey().$defaultFn(() => generateId()),
  executionId: text("execution_id").notNull().references(() => workflowExecutions.id),
  nodeId: text("node_id").notNull(),
  integrationType: text("integration_type").notNull(),
  // e.g., "openai", "slack"
  credentialKeys: jsonb("credential_keys").notNull().$type(),
  // Keys that were resolved
  source: text("source").notNull().$type(),
  fallbackAttempted: boolean("fallback_attempted").default(false),
  fallbackReason: text("fallback_reason"),
  accessedAt: timestamp("accessed_at").notNull().defaultNow()
});
var runtimeConfigAuditLogs = pgTable(
  "runtime_config_audit_logs",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    storeName: text("store_name").notNull(),
    configKey: text("config_key").notNull(),
    value: text("value").notNull(),
    metadata: jsonb("metadata").$type(),
    status: text("status").notNull().$type(),
    provider: text("provider"),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB payload from writer service
    providerResponse: jsonb("provider_response").$type(),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow()
  },
  (table) => ({
    projectCreatedIdx: index("idx_runtime_cfg_audit_project_created").on(
      table.projectId,
      table.createdAt
    ),
    projectKeyIdx: index("idx_runtime_cfg_audit_project_key").on(
      table.projectId,
      table.configKey
    )
  })
);
var workflowExternalEvents = pgTable("workflow_external_events", {
  id: text("id").primaryKey().$defaultFn(() => generateId()),
  executionId: text("execution_id").notNull().references(() => workflowExecutions.id),
  nodeId: text("node_id").notNull(),
  eventName: text("event_name").notNull(),
  // e.g., "plan-approval"
  eventType: text("event_type").notNull().$type(),
  requestedAt: timestamp("requested_at"),
  timeoutSeconds: integer("timeout_seconds"),
  expiresAt: timestamp("expires_at"),
  respondedAt: timestamp("responded_at"),
  approved: boolean("approved"),
  reason: text("reason"),
  respondedBy: text("responded_by"),
  // User ID or identifier who responded
  // biome-ignore lint/suspicious/noExplicitAny: JSONB type - event payload
  payload: jsonb("payload").$type(),
  createdAt: timestamp("created_at").notNull().defaultNow()
});
var platformOauthApps = pgTable(
  "platform_oauth_apps",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    platformId: text("platform_id").notNull().references(() => platforms.id, { onDelete: "cascade" }),
    pieceName: text("piece_name").notNull(),
    // e.g. "@activepieces/piece-google-sheets"
    clientId: text("client_id").notNull(),
    clientSecret: jsonb("client_secret").notNull().$type(),
    // AES-256-CBC encrypted
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    platformPieceUnique: unique("uq_platform_oauth_apps_platform_piece").on(
      table.platformId,
      table.pieceName
    )
  })
);
var platformDisabledPieces = pgTable(
  "platform_disabled_piece",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    platformId: text("platform_id").notNull().default("default-platform"),
    pieceName: text("piece_name").notNull(),
    disabledBy: text("disabled_by"),
    disabledAt: timestamp("disabled_at").notNull().defaultNow()
  },
  (table) => ({
    platformPieceUnique: unique("uq_platform_disabled_piece_platform_piece").on(
      table.platformId,
      table.pieceName
    )
  })
);
var pieceImages = pgTable(
  "piece_images",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    pieceName: text("piece_name").notNull(),
    version: text("version").notNull(),
    image: text("image"),
    digest: text("digest"),
    // building | ready | failed
    status: text("status").notNull().default("building"),
    errorMessage: text("error_message"),
    builtAt: timestamp("built_at"),
    enabledAt: timestamp("enabled_at"),
    disabledAt: timestamp("disabled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    pieceVersionUnique: unique("uq_piece_images_piece_version").on(
      table.pieceName,
      table.version
    ),
    pieceStatusIdx: index("idx_piece_images_piece_status").on(
      table.pieceName,
      table.status
    )
  })
);
var apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey().$defaultFn(() => generateId()),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name"),
  // Optional label for the API key
  keyHash: text("key_hash").notNull(),
  // Store hashed version of the key
  keyPrefix: text("key_prefix").notNull(),
  // Store first few chars for display (e.g., "wf_abc...")
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at")
});
var modelProviders = pgTable(
  "model_providers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    iconKey: text("icon_key").notNull().$type(),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    isEnabled: boolean("is_enabled").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    nameUnique: unique("uq_model_providers_name").on(table.name),
    enabledIdx: index("idx_model_providers_enabled").on(table.isEnabled),
    sortIdx: index("idx_model_providers_sort_order").on(table.sortOrder)
  })
);
var modelCatalog = pgTable(
  "model_catalog",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    providerId: text("provider_id").notNull().references(() => modelProviders.id, { onDelete: "cascade" }),
    modelKey: text("model_key").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    isEnabled: boolean("is_enabled").notNull().default(true),
    metadata: jsonb("metadata").$type(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    providerModelUnique: unique("uq_model_catalog_provider_model").on(
      table.providerId,
      table.modelKey
    ),
    enabledIdx: index("idx_model_catalog_enabled").on(table.isEnabled),
    providerSortIdx: index("idx_model_catalog_provider_sort").on(
      table.providerId,
      table.sortOrder
    )
  })
);
var agentInstructionFacets = pgTable(
  "agent_instruction_facets",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    enabledIdx: index("idx_agent_instruction_facets_enabled").on(
      table.isEnabled
    ),
    sortIdx: index("idx_agent_instruction_facets_sort").on(table.sortOrder)
  })
);
var agentInstructionFacetVersions = pgTable(
  "agent_instruction_facet_versions",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    facetId: text("facet_id").notNull().references(() => agentInstructionFacets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: jsonb("config").notNull().$type(),
    compatibility: jsonb("compatibility").$type(),
    isDefault: boolean("is_default").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    facetVersionUnique: unique("uq_agent_instruction_facet_version").on(
      table.facetId,
      table.version
    ),
    facetIdx: index("idx_agent_instruction_facet_versions_facet").on(
      table.facetId
    ),
    defaultIdx: index("idx_agent_instruction_facet_versions_default").on(
      table.isDefault
    )
  })
);
var agentModelFacets = pgTable(
  "agent_model_facets",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    enabledIdx: index("idx_agent_model_facets_enabled").on(table.isEnabled),
    sortIdx: index("idx_agent_model_facets_sort").on(table.sortOrder)
  })
);
var agentModelFacetVersions = pgTable(
  "agent_model_facet_versions",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    facetId: text("facet_id").notNull().references(() => agentModelFacets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: jsonb("config").notNull().$type(),
    compatibility: jsonb("compatibility").$type(),
    isDefault: boolean("is_default").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    facetVersionUnique: unique("uq_agent_model_facet_version").on(
      table.facetId,
      table.version
    ),
    facetIdx: index("idx_agent_model_facet_versions_facet").on(table.facetId),
    defaultIdx: index("idx_agent_model_facet_versions_default").on(
      table.isDefault
    )
  })
);
var agentToolPolicyFacets = pgTable(
  "agent_tool_policy_facets",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    enabledIdx: index("idx_agent_tool_policy_facets_enabled").on(
      table.isEnabled
    ),
    sortIdx: index("idx_agent_tool_policy_facets_sort").on(table.sortOrder)
  })
);
var agentToolPolicyFacetVersions = pgTable(
  "agent_tool_policy_facet_versions",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    facetId: text("facet_id").notNull().references(() => agentToolPolicyFacets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: jsonb("config").notNull().$type(),
    compatibility: jsonb("compatibility").$type(),
    isDefault: boolean("is_default").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    facetVersionUnique: unique("uq_agent_tool_policy_facet_version").on(
      table.facetId,
      table.version
    ),
    facetIdx: index("idx_agent_tool_policy_facet_versions_facet").on(
      table.facetId
    ),
    defaultIdx: index("idx_agent_tool_policy_facet_versions_default").on(
      table.isDefault
    )
  })
);
var agentMemoryFacets = pgTable(
  "agent_memory_facets",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    enabledIdx: index("idx_agent_memory_facets_enabled").on(table.isEnabled),
    sortIdx: index("idx_agent_memory_facets_sort").on(table.sortOrder)
  })
);
var agentMemoryFacetVersions = pgTable(
  "agent_memory_facet_versions",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    facetId: text("facet_id").notNull().references(() => agentMemoryFacets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: jsonb("config").notNull().$type(),
    compatibility: jsonb("compatibility").$type(),
    isDefault: boolean("is_default").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    facetVersionUnique: unique("uq_agent_memory_facet_version").on(
      table.facetId,
      table.version
    ),
    facetIdx: index("idx_agent_memory_facet_versions_facet").on(table.facetId),
    defaultIdx: index("idx_agent_memory_facet_versions_default").on(
      table.isDefault
    )
  })
);
var agentExecutionFacets = pgTable(
  "agent_execution_facets",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    enabledIdx: index("idx_agent_execution_facets_enabled").on(table.isEnabled),
    sortIdx: index("idx_agent_execution_facets_sort").on(table.sortOrder)
  })
);
var agentExecutionFacetVersions = pgTable(
  "agent_execution_facet_versions",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    facetId: text("facet_id").notNull().references(() => agentExecutionFacets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: jsonb("config").notNull().$type(),
    compatibility: jsonb("compatibility").$type(),
    isDefault: boolean("is_default").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    facetVersionUnique: unique("uq_agent_execution_facet_version").on(
      table.facetId,
      table.version
    ),
    facetIdx: index("idx_agent_execution_facet_versions_facet").on(
      table.facetId
    ),
    defaultIdx: index("idx_agent_execution_facet_versions_default").on(
      table.isDefault
    )
  })
);
var agentInteractionFacets = pgTable(
  "agent_interaction_facets",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    enabledIdx: index("idx_agent_interaction_facets_enabled").on(
      table.isEnabled
    ),
    sortIdx: index("idx_agent_interaction_facets_sort").on(table.sortOrder)
  })
);
var agentInteractionFacetVersions = pgTable(
  "agent_interaction_facet_versions",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    facetId: text("facet_id").notNull().references(() => agentInteractionFacets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: jsonb("config").notNull().$type(),
    compatibility: jsonb("compatibility").$type(),
    isDefault: boolean("is_default").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    facetVersionUnique: unique("uq_agent_interaction_facet_version").on(
      table.facetId,
      table.version
    ),
    facetIdx: index("idx_agent_interaction_facet_versions_facet").on(
      table.facetId
    ),
    defaultIdx: index("idx_agent_interaction_facet_versions_default").on(
      table.isDefault
    )
  })
);
var agentOutputFacets = pgTable(
  "agent_output_facets",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    enabledIdx: index("idx_agent_output_facets_enabled").on(table.isEnabled),
    sortIdx: index("idx_agent_output_facets_sort").on(table.sortOrder)
  })
);
var agentOutputFacetVersions = pgTable(
  "agent_output_facet_versions",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    facetId: text("facet_id").notNull().references(() => agentOutputFacets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: jsonb("config").notNull().$type(),
    compatibility: jsonb("compatibility").$type(),
    isDefault: boolean("is_default").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    facetVersionUnique: unique("uq_agent_output_facet_version").on(
      table.facetId,
      table.version
    ),
    facetIdx: index("idx_agent_output_facet_versions_facet").on(table.facetId),
    defaultIdx: index("idx_agent_output_facet_versions_default").on(
      table.isDefault
    )
  })
);
var agentCapabilityFacets = pgTable(
  "agent_capability_facets",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    enabledIdx: index("idx_agent_capability_facets_enabled").on(
      table.isEnabled
    ),
    sortIdx: index("idx_agent_capability_facets_sort").on(table.sortOrder)
  })
);
var agentCapabilityFacetVersions = pgTable(
  "agent_capability_facet_versions",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    facetId: text("facet_id").notNull().references(() => agentCapabilityFacets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: jsonb("config").notNull().$type(),
    compatibility: jsonb("compatibility").$type(),
    isDefault: boolean("is_default").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    facetVersionUnique: unique("uq_agent_capability_facet_version").on(
      table.facetId,
      table.version
    ),
    facetIdx: index("idx_agent_capability_facet_versions_facet").on(
      table.facetId
    ),
    defaultIdx: index("idx_agent_capability_facet_versions_default").on(
      table.isDefault
    )
  })
);
var agentProfileTemplates = pgTable(
  "agent_profile_templates",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category"),
    sourceRepoUrl: text("source_repo_url"),
    sourcePath: text("source_path"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    enabledIdx: index("idx_agent_profile_templates_enabled").on(
      table.isEnabled
    ),
    sortIdx: index("idx_agent_profile_templates_sort").on(table.sortOrder)
  })
);
var agentProfileTemplateVersions = pgTable(
  "agent_profile_template_versions",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    templateId: text("template_id").notNull().references(() => agentProfileTemplates.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    instructionFacetVersionId: text("instruction_facet_version_id").references(
      () => agentInstructionFacetVersions.id
    ),
    modelFacetVersionId: text("model_facet_version_id").references(
      () => agentModelFacetVersions.id
    ),
    toolPolicyFacetVersionId: text("tool_policy_facet_version_id").references(
      () => agentToolPolicyFacetVersions.id
    ),
    memoryFacetVersionId: text("memory_facet_version_id").references(
      () => agentMemoryFacetVersions.id
    ),
    executionFacetVersionId: text("execution_facet_version_id").references(
      () => agentExecutionFacetVersions.id
    ),
    interactionFacetVersionId: text("interaction_facet_version_id").references(
      () => agentInteractionFacetVersions.id
    ),
    outputFacetVersionId: text("output_facet_version_id").references(
      () => agentOutputFacetVersions.id
    ),
    capabilityFacetVersionId: text("capability_facet_version_id").references(
      () => agentCapabilityFacetVersions.id
    ),
    compatibility: jsonb("compatibility").$type(),
    notes: text("notes"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    templateVersionUnique: unique("uq_agent_profile_template_version").on(
      table.templateId,
      table.version
    ),
    templateIdx: index("idx_agent_profile_template_versions_template").on(
      table.templateId
    ),
    defaultIdx: index("idx_agent_profile_template_versions_default").on(
      table.isDefault
    )
  })
);
var agentProfileTemplateExamples = pgTable(
  "agent_profile_template_examples",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    templateId: text("template_id").notNull().references(() => agentProfileTemplates.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    sourceRepoUrl: text("source_repo_url").notNull(),
    sourcePath: text("source_path").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  }
);
var agentSkillRegistry = pgTable(
  "agent_skill_registry",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    whenToUse: text("when_to_use"),
    prompt: text("prompt").notNull(),
    allowedTools: jsonb("allowed_tools").$type(),
    arguments: jsonb("arguments").$type(),
    argumentHint: text("argument_hint"),
    model: text("model"),
    userInvocable: boolean("user_invocable").notNull().default(true),
    disableModelInvocation: boolean("disable_model_invocation").notNull().default(false),
    sourceType: text("source_type").notNull().default("curated").$type(),
    sourceRepo: text("source_repo"),
    sourceRef: text("source_ref"),
    skillPath: text("skill_path"),
    registryUrl: text("registry_url"),
    installSource: text("install_source"),
    skillName: text("skill_name"),
    installAgent: text("install_agent").notNull().default("universal"),
    version: text("version").notNull().default("1"),
    contentHash: text("content_hash").notNull(),
    license: text("license"),
    compatibility: jsonb("compatibility").$type(),
    packageManifest: jsonb("package_manifest").$type(),
    status: text("status").notNull().default("ENABLED").$type(),
    createdByUserId: text("created_by_user_id").references(() => users.id),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade"
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    statusIdx: index("idx_agent_skill_registry_status").on(table.status),
    sourceIdx: index("idx_agent_skill_registry_source").on(
      table.sourceRepo,
      table.skillPath
    ),
    projectIdx: index("idx_agent_skill_registry_project").on(table.projectId)
  })
);
var resourcePrompts = pgTable(
  "resource_prompts",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    name: text("name").notNull(),
    description: text("description"),
    systemPrompt: text("system_prompt").notNull(),
    userPrompt: text("user_prompt"),
    promptMode: text("prompt_mode").notNull().default("system").$type(),
    metadata: jsonb("metadata").$type(),
    version: integer("version").notNull().default(1),
    isEnabled: boolean("is_enabled").notNull().default(true),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade"
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    userProjectIdx: index("idx_resource_prompts_user_project").on(
      table.userId,
      table.projectId
    ),
    enabledIdx: index("idx_resource_prompts_enabled").on(table.isEnabled),
    userProjectNameUnique: unique("uq_resource_prompts_user_project_name").on(
      table.userId,
      table.projectId,
      table.name
    )
  })
);
var resourcePromptVersions = pgTable(
  "resource_prompt_versions",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    promptId: text("prompt_id").notNull().references(() => resourcePrompts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    messages: jsonb("messages").notNull().$type(),
    templateArguments: jsonb("arguments").notNull().default([]).$type(),
    templateFormat: text("template_format").notNull().default("mustache").$type(),
    templateHash: text("template_hash").notNull(),
    metadata: jsonb("metadata").$type(),
    mlflowUri: text("mlflow_uri"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("created_at").notNull().defaultNow()
  },
  (table) => ({
    promptVersionUnique: unique(
      "uq_resource_prompt_versions_prompt_version"
    ).on(table.promptId, table.version),
    promptIdx: index("idx_resource_prompt_versions_prompt").on(table.promptId),
    templateHashIdx: index("idx_resource_prompt_versions_template_hash").on(
      table.templateHash
    ),
    mlflowUriIdx: index("idx_resource_prompt_versions_mlflow_uri").on(
      table.mlflowUri
    )
  })
);
var resourceSchemas = pgTable(
  "resource_schemas",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    name: text("name").notNull(),
    description: text("description"),
    schemaType: text("schema_type").notNull().default("json-schema").$type(),
    // biome-ignore lint/suspicious/noExplicitAny: JSON schema shape
    schema: jsonb("schema").notNull().$type(),
    metadata: jsonb("metadata").$type(),
    version: integer("version").notNull().default(1),
    isEnabled: boolean("is_enabled").notNull().default(true),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade"
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    userProjectIdx: index("idx_resource_schemas_user_project").on(
      table.userId,
      table.projectId
    ),
    enabledIdx: index("idx_resource_schemas_enabled").on(table.isEnabled),
    userProjectNameUnique: unique("uq_resource_schemas_user_project_name").on(
      table.userId,
      table.projectId,
      table.name
    )
  })
);
var resourceModelProfiles = pgTable(
  "resource_model_profiles",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    name: text("name").notNull(),
    description: text("description"),
    model: jsonb("model").notNull().$type(),
    defaultOptions: jsonb("default_options").$type(),
    maxTurns: integer("max_turns"),
    timeoutMinutes: integer("timeout_minutes"),
    metadata: jsonb("metadata").$type(),
    version: integer("version").notNull().default(1),
    isEnabled: boolean("is_enabled").notNull().default(true),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade"
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    userProjectIdx: index("idx_resource_model_profiles_user_project").on(
      table.userId,
      table.projectId
    ),
    enabledIdx: index("idx_resource_model_profiles_enabled").on(
      table.isEnabled
    ),
    userProjectNameUnique: unique(
      "uq_resource_model_profiles_user_project_name"
    ).on(table.userId, table.projectId, table.name)
  })
);
var workflowResourceRefs = pgTable(
  "workflow_resource_refs",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    workflowId: text("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    resourceType: text("resource_type").notNull().$type(),
    resourceId: text("resource_id").notNull(),
    resourceVersion: integer("resource_version"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    workflowNodeIdx: index("idx_workflow_resource_refs_workflow_node").on(
      table.workflowId,
      table.nodeId
    ),
    resourceLookupIdx: index("idx_workflow_resource_refs_resource_lookup").on(
      table.resourceType,
      table.resourceId
    )
  })
);
var workflowExecutionsRelations = relations(
  workflowExecutions,
  ({ one, many }) => ({
    workflow: one(workflows, {
      fields: [workflowExecutions.workflowId],
      references: [workflows.id]
    }),
    planArtifacts: many(workflowPlanArtifacts),
    browserArtifacts: many(workflowBrowserArtifacts),
    codeCheckpoints: many(workflowCodeCheckpoints)
  })
);
var workflowCodeCheckpointsRelations = relations(
  workflowCodeCheckpoints,
  ({ one }) => ({
    workflowExecution: one(workflowExecutions, {
      fields: [workflowCodeCheckpoints.workflowExecutionId],
      references: [workflowExecutions.id]
    }),
    agentRun: one(workflowAgentRuns, {
      fields: [workflowCodeCheckpoints.workflowAgentRunId],
      references: [workflowAgentRuns.id]
    })
  })
);
var workflowPlanArtifactsRelations = relations(
  workflowPlanArtifacts,
  ({ one }) => ({
    workflowExecution: one(workflowExecutions, {
      fields: [workflowPlanArtifacts.workflowExecutionId],
      references: [workflowExecutions.id]
    }),
    workflow: one(workflows, {
      fields: [workflowPlanArtifacts.workflowId],
      references: [workflows.id]
    }),
    user: one(users, {
      fields: [workflowPlanArtifacts.userId],
      references: [users.id]
    })
  })
);
var workflowBrowserArtifactsRelations = relations(
  workflowBrowserArtifacts,
  ({ one }) => ({
    workflowExecution: one(workflowExecutions, {
      fields: [workflowBrowserArtifacts.workflowExecutionId],
      references: [workflowExecutions.id]
    }),
    workflow: one(workflows, {
      fields: [workflowBrowserArtifacts.workflowId],
      references: [workflows.id]
    })
  })
);
var environments = pgTable(
  "environments",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    avatar: text("avatar"),
    tags: jsonb("tags").$type().notNull().default([]),
    runtime: text("runtime").notNull().default("cloud"),
    currentVersionId: text("current_version_id"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null"
    }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade"
    }),
    isArchived: boolean("is_archived").notNull().default(false),
    // Catalog metadata absorbed from sandbox_profiles in migration 0038.
    // `isBuiltin: true` guards the seeded envs (dapr-agent, dapr-agent-xlsx,
    // dapr-agent-animation, dapr-agent-datasci, dapr-agent-webdev) from
    // archive+delete. `baseEnvSlug` replaces the old base_profile_slug —
    // null means the Dockerfile FROMs the root openshell-sandbox image;
    // otherwise it points at another env's slug (1-level inheritance).
    isBuiltin: boolean("is_builtin").notNull().default(false),
    baseEnvSlug: text("base_env_slug"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    slugUnique: unique("uq_environments_slug").on(table.slug),
    archivedIdx: index("idx_environments_archived").on(table.isArchived),
    projectIdx: index("idx_environments_project").on(table.projectId),
    builtinIdx: index("idx_environments_builtin").on(table.isBuiltin),
    baseIdx: index("idx_environments_base").on(table.baseEnvSlug)
  })
);
var environmentVersions = pgTable(
  "environment_versions",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    environmentId: text("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: jsonb("config").notNull().$type(),
    configHash: text("config_hash").notNull(),
    changelog: text("changelog"),
    publishedAt: timestamp("published_at"),
    publishedBy: text("published_by").references(() => users.id, {
      onDelete: "set null"
    }),
    // Build artifacts absorbed from sandbox_profiles in migration 0038.
    // Filled in by the Tekton pipeline + admin-console polling. `imageTag`
    // is the specific tag the sandbox should pull (includes git SHA for
    // cacheability). A new version bumps iff config changed — build state
    // stays on the current version until the next package edit.
    imageTag: text("image_tag"),
    dockerfilePath: text("dockerfile_path"),
    lastBuildSha: text("last_build_sha"),
    lastBuildAt: timestamp("last_build_at"),
    lastBuildStatus: text("last_build_status"),
    lastBuildError: text("last_build_error"),
    createdAt: timestamp("created_at").notNull().defaultNow()
  },
  (table) => ({
    versionUnique: unique("uq_environment_version").on(
      table.environmentId,
      table.version
    ),
    hashIdx: index("idx_environment_versions_hash").on(table.configHash),
    environmentIdx: index("idx_environment_versions_environment").on(
      table.environmentId
    )
  })
);
var sandboxProfiles = pgTable(
  "sandbox_profiles",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    // null = inherits from the root `openshell-sandbox:latest` image.
    // Otherwise this must be another profile's slug; the resolved
    // `FROM` in the generated Dockerfile is the parent profile's
    // current imageTag. 1-level inheritance — no chains.
    baseProfileSlug: text("base_profile_slug"),
    packages: jsonb("packages").$type().notNull().default({}),
    // Capability flags surfaced to _workspace_capabilities() in the
    // runtime. Derived from packages during seed but can be hand-edited.
    capabilities: jsonb("capabilities").$type().notNull().default([]),
    // Build tracking — filled in by the Tekton pipeline + admin-
    // console polling. `imageTag` is the specific tag the sandbox
    // should pull (includes git SHA for cacheability).
    dockerfilePath: text("dockerfile_path"),
    imageTag: text("image_tag"),
    lastBuildSha: text("last_build_sha"),
    lastBuildAt: timestamp("last_build_at"),
    lastBuildStatus: text("last_build_status"),
    lastBuildError: text("last_build_error"),
    // `isBuiltin: true` guards the seeded profiles
    // (dapr-agent, dapr-agent-xlsx, dapr-agent-animation,
    // dapr-agent-datasci, dapr-agent-webdev) from archive+delete.
    isArchived: boolean("is_archived").notNull().default(false),
    isBuiltin: boolean("is_builtin").notNull().default(false),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null"
    }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade"
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    archivedIdx: index("idx_sandbox_profiles_archived").on(table.isArchived),
    projectIdx: index("idx_sandbox_profiles_project").on(table.projectId).where(sql`${table.projectId} IS NOT NULL`),
    baseIdx: index("idx_sandbox_profiles_base").on(table.baseProfileSlug)
  })
);
var agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    avatar: text("avatar"),
    tags: jsonb("tags").$type().notNull().default([]),
    runtime: text("runtime").notNull().default("dapr-agent-py"),
    // Physical Dapr app-id stamped on the per-agent runtime pod (browser/
    // Playwright agents) or on the per-session Sandbox (everything else).
    // Usually `agent-runtime-<slug>`; with shared pools enabled this can be
    // `agent-runtime-pool-<class>`. Stays null for archived / unpublished rows.
    runtimeAppId: text("runtime_app_id"),
    // Mirror of the SandboxWarmPool / per-session Sandbox status so the
    // agent detail page can render Sleeping / Starting / Active / Failed
    // without a live Kubernetes API hit. Updated by a lightweight reconcile
    // poll.
    runtimeStatus: text("runtime_status").notNull().default("pending"),
    runtimeStatusSyncedAt: timestamp("runtime_status_synced_at", {
      withTimezone: true
    }),
    currentVersionId: text("current_version_id"),
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "restrict"
    }),
    environmentVersion: integer("environment_version"),
    defaultVaultIds: jsonb("default_vault_ids").$type().notNull().default([]),
    sourceTemplateSlug: text("source_template_slug"),
    sourceTemplateVersion: integer("source_template_version"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null"
    }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade"
    }),
    isArchived: boolean("is_archived").notNull().default(false),
    registryStatus: text("registry_status").notNull().default("unregistered"),
    registrySyncedAt: timestamp("registry_synced_at", { withTimezone: true }),
    registryError: text("registry_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    slugUnique: unique("uq_agents_slug").on(table.slug),
    archivedIdx: index("idx_agents_archived").on(table.isArchived),
    environmentIdx: index("idx_agents_environment").on(table.environmentId),
    projectIdx: index("idx_agents_project").on(table.projectId),
    registryStatusIdx: index("idx_agents_registry_status").on(
      table.registryStatus
    )
  })
);
var agentVersions = pgTable(
  "agent_versions",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: jsonb("config").notNull().$type(),
    configHash: text("config_hash").notNull(),
    applicationStateDigest: text("application_state_digest"),
    mlflowUri: text("mlflow_uri"),
    mlflowModelName: text("mlflow_model_name"),
    mlflowModelVersion: text("mlflow_model_version"),
    changelog: text("changelog"),
    publishedAt: timestamp("published_at"),
    publishedBy: text("published_by").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("created_at").notNull().defaultNow()
  },
  (table) => ({
    versionUnique: unique("uq_agent_version").on(table.agentId, table.version),
    hashIdx: index("idx_agent_versions_hash").on(table.configHash),
    stateDigestIdx: index("idx_agent_versions_state_digest").on(
      table.applicationStateDigest
    ),
    agentIdx: index("idx_agent_versions_agent").on(table.agentId),
    mlflowUriIdx: index("idx_agent_versions_mlflow_uri").on(table.mlflowUri)
  })
);
var capabilityBundles = pgTable(
  "capability_bundles",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    tags: jsonb("tags").$type().notNull().default([]),
    currentVersionId: text("current_version_id"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null"
    }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade"
    }),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    slugUnique: unique("uq_capability_bundles_slug").on(table.slug),
    projectIdx: index("idx_capability_bundles_project").on(table.projectId),
    archivedIdx: index("idx_capability_bundles_archived").on(table.isArchived)
  })
);
var capabilityBundleVersions = pgTable(
  "capability_bundle_versions",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    bundleId: text("bundle_id").notNull().references(() => capabilityBundles.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: jsonb("config").notNull().$type(),
    configHash: text("config_hash").notNull(),
    changelog: text("changelog"),
    publishedAt: timestamp("published_at"),
    publishedBy: text("published_by").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("created_at").notNull().defaultNow()
  },
  (table) => ({
    versionUnique: unique("uq_capability_bundle_version").on(
      table.bundleId,
      table.version
    ),
    bundleIdx: index("idx_capability_bundle_versions_bundle").on(
      table.bundleId
    ),
    hashIdx: index("idx_capability_bundle_versions_hash").on(table.configHash)
  })
);
var mlflowLineageLinks = pgTable(
  "mlflow_lineage_links",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    sourceKey: text("source_key").notNull(),
    entityType: text("entity_type").notNull().$type(),
    entityId: text("entity_id").notNull(),
    entityVersion: text("entity_version"),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null"
    }),
    mlflowEntityType: text("mlflow_entity_type").notNull().$type(),
    mlflowExperimentId: text("mlflow_experiment_id"),
    mlflowRunId: text("mlflow_run_id"),
    mlflowSessionId: text("mlflow_session_id"),
    mlflowTraceId: text("mlflow_trace_id"),
    mlflowDatasetId: text("mlflow_dataset_id"),
    mlflowDatasetRecordId: text("mlflow_dataset_record_id"),
    mlflowLoggedModelId: text("mlflow_logged_model_id"),
    mlflowLoggedModelName: text("mlflow_logged_model_name"),
    mlflowLoggedModelUri: text("mlflow_logged_model_uri"),
    mlflowModelVersion: text("mlflow_model_version"),
    mlflowPromptUri: text("mlflow_prompt_uri"),
    mlflowPromptName: text("mlflow_prompt_name"),
    mlflowPromptVersion: text("mlflow_prompt_version"),
    mlflowPublicUrl: text("mlflow_public_url"),
    tags: jsonb("tags").$type().notNull().default({}),
    metadata: jsonb("metadata").$type().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    sourceKeyUnique: unique("uq_mlflow_lineage_links_source_key").on(
      table.sourceKey
    ),
    localEntityIdx: index("idx_mlflow_lineage_links_local_entity").on(
      table.entityType,
      table.entityId,
      table.entityVersion
    ),
    projectIdx: index("idx_mlflow_lineage_links_project").on(table.projectId),
    mlflowRunIdx: index("idx_mlflow_lineage_links_mlflow_run").on(
      table.mlflowRunId
    ),
    mlflowSessionIdx: index("idx_mlflow_lineage_links_mlflow_session").on(
      table.mlflowSessionId
    ),
    mlflowTraceIdx: index("idx_mlflow_lineage_links_mlflow_trace").on(
      table.mlflowTraceId
    ),
    mlflowDatasetIdx: index("idx_mlflow_lineage_links_mlflow_dataset").on(
      table.mlflowDatasetId
    ),
    mlflowLoggedModelIdx: index(
      "idx_mlflow_lineage_links_mlflow_logged_model"
    ).on(table.mlflowLoggedModelUri),
    mlflowPromptIdx: index("idx_mlflow_lineage_links_mlflow_prompt").on(
      table.mlflowPromptUri
    )
  })
);
var vaults = pgTable(
  "vaults",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    name: text("name").notNull(),
    description: text("description"),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade"
    }),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null"
    }),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    nameProjectUnique: unique("uq_vaults_project_name").on(
      table.projectId,
      table.name
    ),
    projectIdx: index("idx_vaults_project").on(table.projectId),
    archivedIdx: index("idx_vaults_archived").on(table.isArchived)
  })
);
var vaultCredentials = pgTable(
  "vault_credentials",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    vaultId: text("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    authType: text("auth_type").notNull(),
    value: jsonb("value").notNull().$type(),
    mcpServerUrl: text("mcp_server_url"),
    refreshMetadata: jsonb("refresh_metadata").$type(),
    expiresAt: timestamp("expires_at"),
    lastRefreshedAt: timestamp("last_refreshed_at"),
    lastUsedAt: timestamp("last_used_at"),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    vaultIdx: index("idx_vault_credentials_vault").on(table.vaultId),
    mcpUrlIdx: index("idx_vault_credentials_mcp_url").on(table.mcpServerUrl),
    expiresIdx: index("idx_vault_credentials_expires").on(table.expiresAt)
  })
);
var vaultCredentialRefreshLog = pgTable(
  "vault_credential_refresh_log",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    credentialId: text("credential_id").notNull().references(() => vaultCredentials.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    // "success" | "failure"
    errorMessage: text("error_message"),
    responseStatus: integer("response_status"),
    attemptedAt: timestamp("attempted_at").notNull().defaultNow()
  },
  (table) => ({
    credentialIdx: index("idx_vault_refresh_log_credential").on(
      table.credentialId
    ),
    attemptedIdx: index("idx_vault_refresh_log_attempted").on(
      table.attemptedAt
    )
  })
);
var userCliCredentials = pgTable(
  "user_cli_credentials",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    value: jsonb("value").notNull().$type(),
    expiresAt: timestamp("expires_at"),
    lastValidatedAt: timestamp("last_validated_at"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    userProviderUnique: unique("uq_user_cli_credentials_user_provider").on(
      table.userId,
      table.provider
    ),
    userIdx: index("idx_user_cli_credentials_user").on(table.userId)
  })
);
var cliCredentialLocks = pgTable(
  "cli_credential_locks",
  {
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    holderSessionId: text("holder_session_id").notNull(),
    acquiredAt: timestamp("acquired_at").notNull().defaultNow()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.provider] })
  })
);
var prPreviews = pgTable("pr_previews", {
  prNumber: integer("pr_number").primaryKey(),
  alias: text("alias").notNull(),
  url: text("url"),
  state: text("state").notNull(),
  headSha: text("head_sha"),
  services: jsonb("services").$type().notNull().default([]),
  /** GitHub/catalog/platform facts derived by the server before launch. */
  authority: jsonb("authority").$type(),
  error: text("error"),
  verify: jsonb("verify").$type(),
  /** Ownership fencing token: bumped by every up/resume takeover; all pipeline
   * writes CAS on it so a deposed pipeline aborts instead of clobbering. */
  ownerGen: integer("owner_gen").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow()
});
var sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    title: text("title"),
    status: text("status").notNull().default("rescheduling"),
    stopReason: jsonb("stop_reason").$type(),
    // Lifecycle stop-intent (mirrors workflow_executions.stop_requested_at):
    // set when a stop is requested; cleared implicitly when status→terminated.
    stopRequestedAt: timestamp("stop_requested_at"),
    // Lifecycle pause-intent: set when the user pauses the run (Dapr
    // suspend_workflow); cleared on resume. Stop/cleanup paths treat rows with
    // this set as an intentional hold rather than terminal cleanup candidates.
    pauseRequestedAt: timestamp("pause_requested_at"),
    agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
    agentVersion: integer("agent_version"),
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "restrict"
    }),
    environmentVersion: integer("environment_version"),
    vaultIds: jsonb("vault_ids").$type().notNull().default([]),
    daprInstanceId: text("dapr_instance_id"),
    natsSubject: text("nats_subject"),
    sandboxName: text("sandbox_name"),
    workspaceSandboxName: text("workspace_sandbox_name"),
    runtimeAppId: text("runtime_app_id"),
    runtimeSandboxName: text("runtime_sandbox_name"),
    workflowExecutionId: text("workflow_execution_id"),
    parentExecutionId: text("parent_execution_id"),
    // Interactive-cli conversation resume: a resumed session is a NEW row
    // that re-mounts the original session's durable transcript subtree (the
    // CSI subPath keys on this id) and launches `claude --continue`. Lineage
    // only — not on the resume critical path (the value is threaded to the
    // sandbox host request, not read back to drive the mount).
    resumedFromSessionId: text("resumed_from_session_id"),
    mlflowExperimentId: text("mlflow_experiment_id"),
    mlflowRunId: text("mlflow_run_id"),
    mlflowParentRunId: text("mlflow_parent_run_id"),
    mlflowSessionId: text("mlflow_session_id"),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade"
    }),
    // Per-session ACTUAL sandbox-pod resource consumption is accumulated by
    // the session-resource-sample CronJob under usage.resource (no dedicated
    // columns — see SessionResourceUsage in application/adapters/session-resource-usage.ts):
    // { peakCpuMillicores, peakMemoryMiB, cpuMillicoreSum, memoryMiBSum,
    //   sampleCount, sampledAt }. peak = max observed; *Sum/sampleCount → avg.
    // Feeds request right-sizing. docs/session-resource-metrics-and-kueue-admission.md.
    usage: jsonb("usage").$type().notNull().default({}),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    // Throttled liveness stamp (migration 0095): last time ANY session event
    // was ingested, bumped at most once per 5s. Distinct from updatedAt (which
    // only moves on status/usage mutations) so the liveness reconciler can tell
    // a quiet-but-alive session from a dead one without scanning session_events.
    lastEventAt: timestamp("last_event_at"),
    // Needs-input cache (migration 0096): a rebuildable snapshot of "this
    // session is waiting on a human" maintained by the single ingest writer —
    // SET on a blocked idle / permission / tool-confirmation request, CLEARed on
    // resume/terminate/error/answer. Lets the session LIST + Fleet surfaces
    // badge a parked session without scanning session_events. Shape = PendingInput
    // ($lib/types/sessions); events stay the source of truth.
    pendingInput: jsonb("pending_input").$type(),
    completedAt: timestamp("completed_at"),
    archivedAt: timestamp("archived_at")
  },
  (table) => ({
    agentIdx: index("idx_sessions_agent").on(table.agentId),
    userIdx: index("idx_sessions_user").on(table.userId),
    statusIdx: index("idx_sessions_status").on(table.status),
    createdIdx: index("idx_sessions_created").on(table.createdAt),
    workflowIdx: index("idx_sessions_workflow_execution").on(
      table.workflowExecutionId
    ),
    sandboxIdx: index("idx_sessions_sandbox_name").on(table.sandboxName),
    workspaceSandboxIdx: index("idx_sessions_workspace_sandbox").on(
      table.workspaceSandboxName
    ),
    runtimeAppIdx: index("idx_sessions_runtime_app_id").on(table.runtimeAppId),
    runtimeSandboxIdx: index("idx_sessions_runtime_sandbox_name").on(
      table.runtimeSandboxName
    ),
    mlflowRunIdx: index("idx_sessions_mlflow_run").on(table.mlflowRunId),
    mlflowParentRunIdx: index("idx_sessions_mlflow_parent_run").on(
      table.mlflowParentRunId
    ),
    mlflowSessionIdx: index("idx_sessions_mlflow_session").on(
      table.mlflowSessionId
    ),
    // Composite partial index that serves the workspace sessions list
    // query (WHERE project_id = X AND archived_at IS NULL ORDER BY
    // created_at DESC LIMIT N). Added in migration 0041.
    projectCreatedIdx: index("idx_sessions_project_created").on(table.projectId, table.createdAt.desc()).where(sql`${table.archivedAt} IS NULL`)
  })
);
var sessionEvents = pgTable(
  "session_events",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    data: jsonb("data").$type().notNull().default({}),
    processedAt: timestamp("processed_at"),
    sourceEventId: text("source_event_id"),
    // Producer-Id triple for durable-streams-shaped idempotency. producerId
    // is the agent slug (joins with agents.slug); producerEpoch is the
    // emitting pod's process start-time in ns. See event_publisher.py and
    // migration 0043. Both columns are nullable so pre-upgrade rows stay
    // valid; the partial unique index uq_session_events_source enforces
    // dedup only when source_event_id IS NOT NULL.
    producerId: text("producer_id"),
    producerEpoch: text("producer_epoch"),
    createdAt: timestamp("created_at").notNull().defaultNow()
  },
  (table) => ({
    sessionSequence: unique("uq_session_event_sequence").on(
      table.sessionId,
      table.sequence
    ),
    sessionIdx: index("idx_session_events_session").on(table.sessionId),
    typeIdx: index("idx_session_events_type").on(table.type),
    createdIdx: index("idx_session_events_created").on(table.createdAt),
    producerIdx: index("idx_session_events_producer").on(
      table.producerId,
      table.producerEpoch
    )
  })
);
var threadGoals = pgTable(
  "thread_goals",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    goalId: text("goal_id").notNull().$defaultFn(() => generateId()),
    objective: text("objective").notNull(),
    // active | paused | budget_limited | complete
    status: text("status").notNull().default("active"),
    tokenBudget: integer("token_budget"),
    tokensUsed: integer("tokens_used").notNull().default(0),
    timeUsedSeconds: integer("time_used_seconds").notNull().default(0),
    iterations: integer("iterations").notNull().default(0),
    maxIterations: integer("max_iterations").notNull().default(50),
    // Evaluator-gated completion (Phase 1): the agent's self-declared
    // completion is verified before the goal is marked complete. acceptance
    // criteria are human/agent-readable; evidence.commands are deterministic
    // shell checks the BFF evaluator runs in the session workspace.
    // See docs/goal-loop-evaluator-design.md.
    acceptanceCriteria: jsonb("acceptance_criteria").$type(),
    evidencePlan: jsonb("evidence_plan").$type(),
    budgetSteeredAt: timestamp("budget_steered_at"),
    lastContinuationAt: timestamp("last_continuation_at"),
    // complete | budget | iteration_cap | interrupt
    stopReason: text("stop_reason"),
    workflowExecutionId: text("workflow_execution_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at")
  },
  (table) => ({
    // At most one active goal per session (codex single-goal-per-thread
    // semantics); historical paused/complete/budget_limited rows are kept.
    activeUq: uniqueIndex("uq_thread_goals_session_active").on(table.sessionId).where(sql`${table.status} = 'active'`),
    sessionIdx: index("idx_thread_goals_session").on(table.sessionId),
    statusIdx: index("idx_thread_goals_status").on(table.status)
  })
);
var benchmarkSuites = pgTable(
  "benchmark_suites",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    datasetName: text("dataset_name").notNull(),
    datasetSplit: text("dataset_split").notNull().default("test"),
    sourceUrl: text("source_url"),
    defaultInstanceLimit: integer("default_instance_limit"),
    metadata: jsonb("metadata").$type().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    slugUnique: unique("uq_benchmark_suites_slug").on(table.slug),
    datasetIdx: index("idx_benchmark_suites_dataset").on(
      table.datasetName,
      table.datasetSplit
    )
  })
);
var benchmarkInstances = pgTable(
  "benchmark_instances",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    suiteId: text("suite_id").notNull().references(() => benchmarkSuites.id, { onDelete: "cascade" }),
    instanceId: text("instance_id").notNull(),
    repo: text("repo"),
    baseCommit: text("base_commit"),
    problemStatement: text("problem_statement"),
    hintsText: text("hints_text"),
    testMetadata: jsonb("test_metadata").$type().notNull().default({}),
    goldPatch: text("gold_patch"),
    mlflowDatasetId: text("mlflow_dataset_id"),
    mlflowDatasetRecordId: text("mlflow_dataset_record_id"),
    metadata: jsonb("metadata").$type().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    suiteInstanceUnique: unique("uq_benchmark_instances_suite_instance").on(
      table.suiteId,
      table.instanceId
    ),
    suiteIdx: index("idx_benchmark_instances_suite").on(table.suiteId),
    instanceIdx: index("idx_benchmark_instances_instance").on(table.instanceId),
    repoIdx: index("idx_benchmark_instances_repo").on(table.repo),
    mlflowDatasetIdx: index("idx_benchmark_instances_mlflow_dataset").on(
      table.mlflowDatasetId
    ),
    mlflowRecordIdx: index("idx_benchmark_instances_mlflow_record").on(
      table.mlflowDatasetRecordId
    )
  })
);
var benchmarkRuns = pgTable(
  "benchmark_runs",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    suiteId: text("suite_id").notNull().references(() => benchmarkSuites.id, { onDelete: "restrict" }),
    agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
    agentVersion: integer("agent_version").notNull(),
    agentRuntime: text("agent_runtime").notNull(),
    agentRuntimeAppId: text("agent_runtime_app_id").notNull(),
    status: text("status").notNull().default("queued").$type(),
    modelNameOrPath: text("model_name_or_path").notNull(),
    modelConfigLabel: text("model_config_label"),
    selectedInstanceIds: jsonb("selected_instance_ids").$type().notNull().default([]),
    concurrency: integer("concurrency").notNull().default(1),
    evaluationConcurrency: integer("evaluation_concurrency").notNull().default(24),
    timeoutSeconds: integer("timeout_seconds").notNull().default(7200),
    maxTurns: integer("max_turns"),
    evaluatorResourceClass: text("evaluator_resource_class").notNull().default("standard"),
    coordinatorExecutionId: text("coordinator_execution_id"),
    evaluatorJobName: text("evaluator_job_name"),
    predictionsPath: text("predictions_path"),
    mlflowExperimentId: text("mlflow_experiment_id"),
    mlflowRunId: text("mlflow_run_id"),
    mlflowDatasetId: text("mlflow_dataset_id"),
    mlflowEvalRunId: text("mlflow_eval_run_id"),
    summary: jsonb("summary").$type().notNull().default({}),
    tags: jsonb("tags").$type().notNull().default([]),
    error: text("error"),
    cancelRequestedAt: timestamp("cancel_requested_at"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    projectCreatedIdx: index("idx_benchmark_runs_project_created").on(
      table.projectId,
      table.createdAt
    ),
    statusIdx: index("idx_benchmark_runs_status").on(table.status),
    suiteIdx: index("idx_benchmark_runs_suite").on(table.suiteId),
    agentIdx: index("idx_benchmark_runs_agent").on(table.agentId),
    mlflowRunIdx: index("idx_benchmark_runs_mlflow_run").on(table.mlflowRunId),
    mlflowDatasetIdx: index("idx_benchmark_runs_mlflow_dataset").on(
      table.mlflowDatasetId
    ),
    mlflowEvalRunIdx: index("idx_benchmark_runs_mlflow_eval_run").on(
      table.mlflowEvalRunId
    )
  })
);
var benchmarkRunInstances = pgTable(
  "benchmark_run_instances",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    runId: text("run_id").notNull().references(() => benchmarkRuns.id, { onDelete: "cascade" }),
    benchmarkInstanceId: text("benchmark_instance_id").references(
      () => benchmarkInstances.id,
      { onDelete: "set null" }
    ),
    instanceId: text("instance_id").notNull(),
    status: text("status").notNull().default("queued").$type(),
    inferenceStatus: text("inference_status").notNull().default("queued").$type(),
    evaluationStatus: text("evaluation_status").notNull().default("pending").$type(),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "set null"
    }),
    workflowExecutionId: text("workflow_execution_id").references(
      () => workflowExecutions.id,
      { onDelete: "set null" }
    ),
    daprInstanceId: text("dapr_instance_id"),
    mlflowRunId: text("mlflow_run_id"),
    mlflowTraceId: text("mlflow_trace_id"),
    mlflowDatasetId: text("mlflow_dataset_id"),
    mlflowDatasetRecordId: text("mlflow_dataset_record_id"),
    sandboxName: text("sandbox_name"),
    workspaceRef: text("workspace_ref"),
    modelPatch: text("model_patch"),
    patchSha256: text("patch_sha256"),
    patchBytes: integer("patch_bytes"),
    usage: jsonb("usage").$type().notNull().default({}),
    timings: jsonb("timings").$type().notNull().default({}),
    traceIds: jsonb("trace_ids").$type().notNull().default([]),
    error: text("error"),
    inferenceError: text("inference_error"),
    evaluationError: text("evaluation_error"),
    logsPath: text("logs_path"),
    testOutputSummary: text("test_output_summary"),
    harnessResult: jsonb("harness_result").$type(),
    patchAddedLines: integer("patch_added_lines"),
    patchRemovedLines: integer("patch_removed_lines"),
    patchFilesTouched: integer("patch_files_touched"),
    patchFilesOverlapGold: integer("patch_files_overlap_gold"),
    patchWellFormed: boolean("patch_well_formed"),
    turnCount: integer("turn_count"),
    toolCallCount: integer("tool_call_count"),
    terminationReason: text("termination_reason"),
    ttftFirstMs: integer("ttft_first_ms"),
    ttftFirstToolMs: integer("ttft_first_tool_ms"),
    toolHistogram: jsonb("tool_histogram").$type().notNull().default({}),
    inferenceEnvironment: jsonb("inference_environment").$type().notNull().default({}),
    startedAt: timestamp("started_at"),
    inferenceCompletedAt: timestamp("inference_completed_at"),
    evaluatedAt: timestamp("evaluated_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    runInstanceUnique: unique("uq_benchmark_run_instances_run_instance").on(
      table.runId,
      table.instanceId
    ),
    runIdx: index("idx_benchmark_run_instances_run").on(table.runId),
    statusIdx: index("idx_benchmark_run_instances_status").on(table.status),
    sessionIdx: index("idx_benchmark_run_instances_session").on(
      table.sessionId
    ),
    workflowExecutionIdx: index(
      "idx_benchmark_run_instances_workflow_execution"
    ).on(table.workflowExecutionId),
    mlflowRunIdx: index("idx_benchmark_run_instances_mlflow_run").on(
      table.mlflowRunId
    ),
    mlflowTraceIdx: index("idx_benchmark_run_instances_mlflow_trace").on(
      table.mlflowTraceId
    ),
    mlflowDatasetIdx: index("idx_benchmark_run_instances_mlflow_dataset").on(
      table.mlflowDatasetId
    ),
    mlflowRecordIdx: index("idx_benchmark_run_instances_mlflow_record").on(
      table.mlflowDatasetRecordId
    )
  })
);
var benchmarkResourceLeases = pgTable(
  "benchmark_resource_leases",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    runId: text("run_id").notNull().references(() => benchmarkRuns.id, { onDelete: "cascade" }),
    instanceId: text("instance_id"),
    phase: text("phase").notNull().default("inference"),
    resourceType: text("resource_type").notNull().$type(),
    capacityKey: text("capacity_key").notNull().default("default"),
    holderId: text("holder_id").notNull(),
    leaseCount: integer("lease_count").notNull().default(1),
    status: text("status").notNull().default("active").$type(),
    metadata: jsonb("metadata").$type().notNull().default({}),
    acquiredAt: timestamp("acquired_at").notNull().defaultNow(),
    heartbeatAt: timestamp("heartbeat_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    releasedAt: timestamp("released_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    runIdx: index("idx_benchmark_resource_leases_run").on(table.runId),
    instanceIdx: index("idx_benchmark_resource_leases_instance").on(
      table.runId,
      table.instanceId
    ),
    resourceIdx: index("idx_benchmark_resource_leases_resource").on(
      table.resourceType,
      table.capacityKey,
      table.status
    ),
    holderIdx: index("idx_benchmark_resource_leases_holder").on(
      table.holderId,
      table.resourceType
    ),
    expiresIdx: index("idx_benchmark_resource_leases_expires").on(
      table.expiresAt
    )
  })
);
var environmentImageBuilds = pgTable(
  "environment_image_builds",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    dataset: text("dataset").notNull(),
    suite: text("suite"),
    repo: text("repo").notNull(),
    version: text("version"),
    environmentSetupCommit: text("environment_setup_commit"),
    baseCommit: text("base_commit"),
    environmentKey: text("environment_key").notNull(),
    envSpecHash: text("env_spec_hash").notNull(),
    buildStrategy: text("build_strategy").notNull().default("swebench-harness").$type(),
    status: text("status").notNull().default("queued").$type(),
    sandboxTemplate: text("sandbox_template").notNull().default("dapr-agent"),
    sandboxImage: text("sandbox_image"),
    digest: text("digest"),
    imageName: text("image_name"),
    imageTag: text("image_tag"),
    dockerfilePath: text("dockerfile_path"),
    validationCommand: text("validation_command"),
    validationStatus: text("validation_status"),
    validationLogRef: text("validation_log_ref"),
    buildLogRef: text("build_log_ref"),
    pipelineRunName: text("pipeline_run_name"),
    pipelineRunNamespace: text("pipeline_run_namespace").default(
      "tekton-pipelines"
    ),
    spec: jsonb("spec").$type().notNull().default({}),
    metadata: jsonb("metadata").$type().notNull().default({}),
    error: text("error"),
    requestedAt: timestamp("requested_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    builtAt: timestamp("built_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    envSpecHashUnique: unique("uq_environment_image_builds_spec_hash").on(
      table.envSpecHash
    ),
    statusIdx: index("idx_environment_image_builds_status").on(table.status),
    environmentKeyIdx: index("idx_environment_image_builds_key").on(
      table.environmentKey
    ),
    repoIdx: index("idx_environment_image_builds_repo").on(table.repo),
    pipelineRunIdx: index("idx_environment_image_builds_pipeline_run").on(
      table.pipelineRunNamespace,
      table.pipelineRunName
    )
  })
);
var benchmarkRunInstanceScores = pgTable(
  "benchmark_run_instance_scores",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    runInstanceId: text("run_instance_id").notNull().references(() => benchmarkRunInstances.id, { onDelete: "cascade" }),
    scorerName: text("scorer_name").notNull(),
    scorerVersion: integer("scorer_version").notNull().default(1),
    score: doublePrecision("score").notNull(),
    reasoning: text("reasoning"),
    metadata: jsonb("metadata").$type().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    uniqueScorer: unique("uq_benchmark_run_instance_scores_unique").on(
      table.runInstanceId,
      table.scorerName,
      table.scorerVersion
    ),
    scorerIdx: index("idx_benchmark_run_instance_scores_scorer").on(
      table.scorerName,
      table.scorerVersion
    ),
    runInstanceIdx: index("idx_benchmark_run_instance_scores_run_instance").on(
      table.runInstanceId
    )
  })
);
var benchmarkRunInstanceAnnotations = pgTable(
  "benchmark_run_instance_annotations",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    runInstanceId: text("run_instance_id").notNull().references(() => benchmarkRunInstances.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    verdict: text("verdict").notNull().$type(),
    reasoning: text("reasoning"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    userUnique: unique("uq_benchmark_run_instance_annotations_user").on(
      table.runInstanceId,
      table.userId
    ),
    runInstanceIdx: index(
      "idx_benchmark_run_instance_annotations_run_instance"
    ).on(table.runInstanceId)
  })
);
var environmentBuildActivityEvents = pgTable(
  "environment_build_activity_events",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    buildId: text("build_id").notNull().references(() => environmentImageBuilds.id, { onDelete: "cascade" }),
    environmentKey: text("environment_key").notNull(),
    eventKey: text("event_key").notNull(),
    eventType: text("event_type").notNull().$type(),
    pipelineRunName: text("pipeline_run_name"),
    pipelineRunNamespace: text("pipeline_run_namespace"),
    taskRunName: text("task_run_name"),
    phase: text("phase"),
    reason: text("reason"),
    message: text("message"),
    eventTimestamp: timestamp("event_timestamp").notNull(),
    rawMetadata: jsonb("raw_metadata").$type().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    buildEventUnique: unique("uq_environment_build_activity_build_event").on(
      table.buildId,
      table.eventKey
    ),
    buildTimelineIdx: index("idx_environment_build_activity_timeline").on(
      table.buildId,
      table.eventTimestamp
    ),
    buildTypeIdx: index("idx_environment_build_activity_type").on(
      table.buildId,
      table.eventType
    ),
    pipelineRunIdx: index("idx_environment_build_activity_pipeline_run").on(
      table.pipelineRunNamespace,
      table.pipelineRunName
    )
  })
);
var gitopsActivityEvents = pgTable(
  "gitops_activity_events",
  {
    eventId: text("event_id").primaryKey(),
    sequence: serial("sequence").notNull(),
    source: text("source").notNull().$type(),
    activityKey: text("activity_key").notNull(),
    activityType: text("activity_type").notNull().$type(),
    phase: text("phase"),
    reason: text("reason"),
    message: text("message"),
    resourceGroup: text("resource_group"),
    resourceVersion: text("resource_version"),
    resourceResource: text("resource_resource"),
    resourceKind: text("resource_kind"),
    resourceNamespace: text("resource_namespace"),
    resourceName: text("resource_name"),
    resourceUid: text("resource_uid"),
    observedAt: timestamp("observed_at").notNull(),
    correlation: jsonb("correlation").$type().notNull().default({}),
    raw: jsonb("raw").$type().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    sequenceUnique: unique("uq_gitops_activity_events_sequence").on(
      table.sequence
    ),
    activityKeyIdx: index("idx_gitops_activity_events_activity_key").on(
      table.activityKey,
      table.observedAt
    ),
    resourceIdx: index("idx_gitops_activity_events_resource").on(
      table.resourceKind,
      table.resourceNamespace,
      table.resourceName
    ),
    observedAtIdx: index("idx_gitops_activity_events_observed_at").on(
      table.observedAt
    ),
    sourceIdx: index("idx_gitops_activity_events_source").on(table.source)
  })
);
var benchmarkArtifacts = pgTable(
  "benchmark_artifacts",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    runId: text("run_id").notNull().references(() => benchmarkRuns.id, { onDelete: "cascade" }),
    runInstanceId: text("run_instance_id").references(
      () => benchmarkRunInstances.id,
      { onDelete: "cascade" }
    ),
    kind: text("kind").notNull().$type(),
    path: text("path").notNull(),
    contentType: text("content_type"),
    sizeBytes: integer("size_bytes"),
    sha256: text("sha256"),
    metadata: jsonb("metadata").$type().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow()
  },
  (table) => ({
    runIdx: index("idx_benchmark_artifacts_run").on(table.runId),
    instanceIdx: index("idx_benchmark_artifacts_instance").on(
      table.runInstanceId
    ),
    kindIdx: index("idx_benchmark_artifacts_kind").on(table.kind)
  })
);
var evaluationDatasets = pgTable(
  "evaluation_datasets",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    sourceType: text("source_type").notNull().default("manual"),
    sourceUrl: text("source_url"),
    schema: jsonb("schema").$type().notNull().default({}),
    metadata: jsonb("metadata").$type().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    projectCreatedIdx: index("idx_evaluation_datasets_project_created").on(
      table.projectId,
      table.createdAt
    ),
    projectNameIdx: index("idx_evaluation_datasets_project_name").on(
      table.projectId,
      table.name
    )
  })
);
var evaluationDatasetRows = pgTable(
  "evaluation_dataset_rows",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    datasetId: text("dataset_id").notNull().references(() => evaluationDatasets.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    input: jsonb("input").$type().notNull().default({}),
    expectedOutput: jsonb("expected_output").$type(),
    generatedOutput: jsonb("generated_output").$type(),
    annotations: jsonb("annotations").$type().notNull().default({}),
    rating: integer("rating"),
    feedback: text("feedback"),
    metadata: jsonb("metadata").$type().notNull().default({}),
    // Phase H — bidirectional link to the benchmark run instance / session
    // this row was captured from. NULL when the row was authored manually
    // (CSV import, hand-crafted, etc.).
    originRunInstanceId: text("origin_run_instance_id"),
    originSessionId: text("origin_session_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    datasetIdx: index("idx_evaluation_dataset_rows_dataset").on(
      table.datasetId
    ),
    externalIdx: index("idx_evaluation_dataset_rows_external").on(
      table.externalId
    ),
    datasetExternalUnique: unique(
      "uq_evaluation_dataset_rows_dataset_external"
    ).on(table.datasetId, table.externalId),
    originRunInstanceIdx: index(
      "idx_evaluation_dataset_rows_origin_run_instance"
    ).on(table.originRunInstanceId),
    originSessionIdx: index("idx_evaluation_dataset_rows_origin_session").on(
      table.originSessionId
    )
  })
);
var evaluations = pgTable(
  "evaluations",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
    datasetId: text("dataset_id").references(() => evaluationDatasets.id, {
      onDelete: "set null"
    }),
    name: text("name").notNull(),
    description: text("description"),
    taskConfig: jsonb("task_config").$type().notNull().default({}),
    dataSourceConfig: jsonb("data_source_config").$type().notNull().default({}),
    testingCriteria: jsonb("testing_criteria").$type().notNull().default({}),
    metadata: jsonb("metadata").$type().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    projectCreatedIdx: index("idx_evaluations_project_created").on(
      table.projectId,
      table.createdAt
    ),
    datasetIdx: index("idx_evaluations_dataset").on(table.datasetId)
  })
);
var evaluationGraders = pgTable(
  "evaluation_graders",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    evaluationId: text("evaluation_id").notNull().references(() => evaluations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull().$type(),
    config: jsonb("config").$type().notNull().default({}),
    weight: integer("weight").notNull().default(1),
    passThreshold: real("pass_threshold").notNull().default(1),
    orderIndex: integer("order_index").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    evaluationIdx: index("idx_evaluation_graders_evaluation").on(
      table.evaluationId
    ),
    typeIdx: index("idx_evaluation_graders_type").on(table.type)
  })
);
var evaluationRuns = pgTable(
  "evaluation_runs",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    evaluationId: text("evaluation_id").notNull().references(() => evaluations.id, { onDelete: "cascade" }),
    datasetId: text("dataset_id").references(() => evaluationDatasets.id, {
      onDelete: "set null"
    }),
    status: text("status").notNull().default("queued").$type(),
    subjectType: text("subject_type").notNull().default("imported_outputs").$type(),
    subjectId: text("subject_id"),
    subjectVersion: text("subject_version"),
    executionConfig: jsonb("execution_config").$type().notNull().default({}),
    coordinatorExecutionId: text("coordinator_execution_id"),
    summary: jsonb("summary").$type().notNull().default({}),
    usage: jsonb("usage").$type().notNull().default({}),
    error: text("error"),
    cancelRequestedAt: timestamp("cancel_requested_at"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    projectCreatedIdx: index("idx_evaluation_runs_project_created").on(
      table.projectId,
      table.createdAt
    ),
    statusIdx: index("idx_evaluation_runs_status").on(table.status),
    evaluationIdx: index("idx_evaluation_runs_evaluation").on(
      table.evaluationId
    ),
    datasetIdx: index("idx_evaluation_runs_dataset").on(table.datasetId)
  })
);
var evaluationRunItems = pgTable(
  "evaluation_run_items",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    runId: text("run_id").notNull().references(() => evaluationRuns.id, { onDelete: "cascade" }),
    datasetRowId: text("dataset_row_id").references(
      () => evaluationDatasetRows.id,
      { onDelete: "set null" }
    ),
    rowIndex: integer("row_index").notNull().default(0),
    status: text("status").notNull().default("queued").$type(),
    input: jsonb("input").$type().notNull().default({}),
    expectedOutput: jsonb("expected_output").$type(),
    generatedOutput: jsonb("generated_output").$type(),
    graderResults: jsonb("grader_results").$type().notNull().default({}),
    scores: jsonb("scores").$type().notNull().default({}),
    usage: jsonb("usage").$type().notNull().default({}),
    traceIds: jsonb("trace_ids").$type().notNull().default([]),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "set null"
    }),
    workflowExecutionId: text("workflow_execution_id").references(
      () => workflowExecutions.id,
      { onDelete: "set null" }
    ),
    daprInstanceId: text("dapr_instance_id"),
    error: text("error"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow()
  },
  (table) => ({
    runIdx: index("idx_evaluation_run_items_run").on(table.runId),
    statusIdx: index("idx_evaluation_run_items_status").on(table.status),
    datasetRowIdx: index("idx_evaluation_run_items_dataset_row").on(
      table.datasetRowId
    ),
    workflowExecutionIdx: index(
      "idx_evaluation_run_items_workflow_execution"
    ).on(table.workflowExecutionId)
  })
);
var evaluationArtifacts = pgTable(
  "evaluation_artifacts",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    runId: text("run_id").notNull().references(() => evaluationRuns.id, { onDelete: "cascade" }),
    runItemId: text("run_item_id").references(() => evaluationRunItems.id, {
      onDelete: "cascade"
    }),
    kind: text("kind").notNull().$type(),
    path: text("path"),
    content: jsonb("content").$type(),
    contentType: text("content_type"),
    sizeBytes: integer("size_bytes"),
    sha256: text("sha256"),
    metadata: jsonb("metadata").$type().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow()
  },
  (table) => ({
    runIdx: index("idx_evaluation_artifacts_run").on(table.runId),
    itemIdx: index("idx_evaluation_artifacts_item").on(table.runItemId),
    kindIdx: index("idx_evaluation_artifacts_kind").on(table.kind)
  })
);
var sessionResources = pgTable(
  "session_resources",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    fileId: text("file_id"),
    mountPath: text("mount_path"),
    repoUrl: text("repo_url"),
    checkoutRef: text("checkout_ref"),
    authTokenCredentialId: text("auth_token_credential_id").references(
      () => vaultCredentials.id,
      { onDelete: "set null" }
    ),
    // Alternative clone-auth source: a GitHub OAuth app_connection (by
    // externalId). EITHER this OR authTokenCredentialId provides the clone
    // token. Plain text (no FK) to match how connections are referenced
    // elsewhere (connectionExternalId); the broker resolves + auto-refreshes
    // the token at clone time via getDecryptedAppConnection().
    appConnectionExternalId: text("app_connection_external_id"),
    mountedAt: timestamp("mounted_at"),
    removedAt: timestamp("removed_at")
  },
  (table) => ({
    sessionIdx: index("idx_session_resources_session").on(table.sessionId)
  })
);
var functions = pgTable("functions", {
  id: text("id").primaryKey().$defaultFn(() => generateId()),
  name: text("name").notNull(),
  // Unique identifier: e.g., "openai/generate-text", "slack/send-message"
  slug: text("slug").notNull().unique(),
  description: text("description"),
  // Plugin this function belongs to: e.g., "openai", "slack", "github"
  pluginId: text("plugin_id").notNull(),
  // Semantic version
  version: text("version").notNull().default("1.0.0"),
  // Execution type determines how the function is invoked
  executionType: text("execution_type").notNull().default("builtin").$type(),
  // For OCI functions: container image reference
  // e.g., "gitea.cnoe.localtest.me:8443/functions/my-func:v1"
  imageRef: text("image_ref"),
  // Override container entrypoint command
  command: text("command"),
  // Working directory inside container
  workingDir: text("working_dir"),
  // Environment variables for container (JSON)
  containerEnv: jsonb("container_env").$type(),
  // For HTTP functions: webhook configuration
  webhookUrl: text("webhook_url"),
  webhookMethod: text("webhook_method").default("POST"),
  webhookHeaders: jsonb("webhook_headers").$type(),
  // Timeout for waiting on webhook response
  webhookTimeoutSeconds: integer("webhook_timeout_seconds").default(30),
  // Input/Output JSON Schema definitions
  // biome-ignore lint/suspicious/noExplicitAny: JSON Schema type
  inputSchema: jsonb("input_schema").$type(),
  // biome-ignore lint/suspicious/noExplicitAny: JSON Schema type
  outputSchema: jsonb("output_schema").$type(),
  // Execution configuration
  timeoutSeconds: integer("timeout_seconds").default(300),
  retryPolicy: jsonb("retry_policy").$type(),
  // Maximum concurrent executions (0 = unlimited)
  maxConcurrency: integer("max_concurrency").default(0),
  // Integration type this function requires (for credential lookup)
  // e.g., "openai", "slack", "github"
  integrationType: text("integration_type"),
  // Feature flags
  isBuiltin: boolean("is_builtin").default(false),
  isEnabled: boolean("is_enabled").default(true),
  isDeprecated: boolean("is_deprecated").default(false),
  // Metadata
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdBy: text("created_by").references(() => users.id)
});
var codeFunctions = pgTable("code_functions", {
  id: text("id").primaryKey().$defaultFn(() => generateId()),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  version: text("version").notNull().default("0.1.0"),
  language: text("language").notNull().$type(),
  entrypoint: text("entrypoint").notNull().default("main"),
  path: text("path"),
  source: text("source").notNull(),
  // biome-ignore lint/suspicious/noExplicitAny: map of relative file path -> source text
  supportingFiles: jsonb("supporting_files").$type(),
  sourceHash: text("source_hash").notNull(),
  // biome-ignore lint/suspicious/noExplicitAny: semantic parser payload is JSONB
  semanticModel: jsonb("semantic_model").$type(),
  // biome-ignore lint/suspicious/noExplicitAny: parser-generated JSON Schema
  inputSchema: jsonb("input_schema").$type(),
  // biome-ignore lint/suspicious/noExplicitAny: parser-generated semantic type payload
  returnType: jsonb("return_type").$type(),
  // biome-ignore lint/suspicious/noExplicitAny: parser-generated import list
  imports: jsonb("imports").$type(),
  // biome-ignore lint/suspicious/noExplicitAny: parser-generated diagnostics list
  diagnostics: jsonb("diagnostics").$type(),
  // biome-ignore lint/suspicious/noExplicitAny: parser-generated capability flags
  capabilities: jsonb("capabilities").$type(),
  role: text("role").notNull().default("function").$type(),
  compositionGraph: jsonb("composition_graph").$type(),
  latestPublishedVersion: text("latest_published_version"),
  lastPublishedAt: timestamp("last_published_at"),
  isEnabled: boolean("is_enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdBy: text("created_by").references(() => users.id)
});
var codeFunctionRevisions = pgTable(
  "code_function_revisions",
  {
    id: text("id").primaryKey().$defaultFn(() => generateId()),
    codeFunctionId: text("code_function_id").notNull().references(() => codeFunctions.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    language: text("language").notNull().$type(),
    entrypoint: text("entrypoint").notNull().default("main"),
    path: text("path"),
    source: text("source").notNull(),
    // biome-ignore lint/suspicious/noExplicitAny: map of relative file path -> source text
    supportingFiles: jsonb("supporting_files").$type(),
    sourceHash: text("source_hash").notNull(),
    // biome-ignore lint/suspicious/noExplicitAny: semantic parser payload is JSONB
    semanticModel: jsonb("semantic_model").$type(),
    // biome-ignore lint/suspicious/noExplicitAny: parser-generated JSON Schema
    inputSchema: jsonb("input_schema").$type(),
    // biome-ignore lint/suspicious/noExplicitAny: parser-generated semantic type payload
    returnType: jsonb("return_type").$type(),
    // biome-ignore lint/suspicious/noExplicitAny: parser-generated import list
    imports: jsonb("imports").$type(),
    // biome-ignore lint/suspicious/noExplicitAny: parser-generated diagnostics list
    diagnostics: jsonb("diagnostics").$type(),
    // biome-ignore lint/suspicious/noExplicitAny: parser-generated capability flags
    capabilities: jsonb("capabilities").$type(),
    role: text("role").notNull().default("function").$type(),
    compositionGraph: jsonb("composition_graph").$type(),
    publishedAt: timestamp("published_at").notNull().defaultNow(),
    createdBy: text("created_by").references(() => users.id)
  },
  (table) => ({
    codeFunctionVersionIdx: unique("uq_code_function_revision_version").on(
      table.codeFunctionId,
      table.version
    )
  })
);
var functionExecutions = pgTable("function_executions", {
  id: text("id").primaryKey().$defaultFn(() => generateId()),
  functionId: text("function_id").references(() => functions.id),
  // Link to the workflow execution that triggered this function
  workflowExecutionId: text("workflow_execution_id").references(
    () => workflowExecutions.id
  ),
  // Node ID within the workflow
  nodeId: text("node_id"),
  // Execution status
  status: text("status").notNull().default("pending").$type(),
  // Input provided to the function
  // biome-ignore lint/suspicious/noExplicitAny: JSONB type
  input: jsonb("input").$type(),
  // Output returned by the function
  // biome-ignore lint/suspicious/noExplicitAny: JSONB type
  output: jsonb("output").$type(),
  // Error message if execution failed
  error: text("error"),
  // For OCI functions: K8s Job name for tracking
  jobName: text("job_name"),
  // For OCI functions: Pod name for log retrieval
  podName: text("pod_name"),
  // Timing
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  durationMs: integer("duration_ms"),
  // Retry tracking
  attemptNumber: integer("attempt_number").default(1),
  lastError: text("last_error")
});
var functionsRelations = relations(functions, ({ one, many }) => ({
  createdByUser: one(users, {
    fields: [functions.createdBy],
    references: [users.id]
  }),
  executions: many(functionExecutions)
}));
var codeFunctionsRelations = relations(codeFunctions, ({ one }) => ({
  createdByUser: one(users, {
    fields: [codeFunctions.createdBy],
    references: [users.id]
  })
}));
var codeFunctionRevisionsRelations = relations(
  codeFunctionRevisions,
  ({ one }) => ({
    codeFunction: one(codeFunctions, {
      fields: [codeFunctionRevisions.codeFunctionId],
      references: [codeFunctions.id]
    }),
    createdByUser: one(users, {
      fields: [codeFunctionRevisions.createdBy],
      references: [users.id]
    })
  })
);
var functionExecutionsRelations = relations(
  functionExecutions,
  ({ one }) => ({
    function: one(functions, {
      fields: [functionExecutions.functionId],
      references: [functions.id]
    }),
    workflowExecution: one(workflowExecutions, {
      fields: [functionExecutions.workflowExecutionId],
      references: [workflowExecutions.id]
    })
  })
);

// src/lib/types/agent-graph.ts
var AGENT_GRAPH_VERSION = "v1";
var AGENT_STEP_TYPES = [
  "input",
  "plan",
  "decide",
  "tool_batch",
  "memory_read",
  "memory_write",
  "memory_compact",
  "approval_gate",
  "delegate",
  "sleep",
  "finish"
];
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
var PERSONA_OVERRIDE_FIELDS = /* @__PURE__ */ new Set([
  "role",
  "goal",
  "instructions",
  "styleGuidelines",
  "style_guidelines",
  "systemPrompt",
  "system_prompt",
  "persona"
]);
function stripPersonaFields(input) {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (!PERSONA_OVERRIDE_FIELDS.has(key)) out[key] = value;
  }
  return out;
}
function sanitizeAgentOverrides(input) {
  if (!isRecord(input)) return void 0;
  const out = {};
  if (isRecord(input.sandboxPolicy)) out.sandboxPolicy = input.sandboxPolicy;
  if (Array.isArray(input.tools)) {
    out.tools = input.tools.map((tool) => typeof tool === "string" ? tool.trim() : String(tool).trim()).filter(Boolean);
  }
  if (typeof input.maxTurns === "number" && Number.isFinite(input.maxTurns)) {
    out.maxTurns = input.maxTurns;
  }
  if (typeof input.timeoutMinutes === "number" && Number.isFinite(input.timeoutMinutes)) {
    out.timeoutMinutes = input.timeoutMinutes;
  }
  if (typeof input.cwd === "string" && input.cwd.trim()) out.cwd = input.cwd.trim();
  return Object.keys(out).length > 0 ? out : void 0;
}
function normalizeStepType(value) {
  return typeof value === "string" && AGENT_STEP_TYPES.includes(value) ? value : "tool_batch";
}
function normalizeNode(input, index2) {
  if (!isRecord(input)) return null;
  const id = typeof input.id === "string" && input.id.trim().length > 0 ? input.id : `agent-step-${index2 + 1}`;
  const position = isRecord(input.position) ? input.position : {};
  const x = typeof position.x === "number" && Number.isFinite(position.x) ? position.x : 120;
  const y = typeof position.y === "number" && Number.isFinite(position.y) ? position.y : 80 + index2 * 120;
  const data = isRecord(input.data) ? input.data : {};
  const stepType = normalizeStepType(data.stepType ?? data.kind ?? input.type);
  const label = typeof data.label === "string" && data.label.trim().length > 0 ? data.label : humanizeStepType(stepType);
  const config = isRecord(data.config) ? data.config : {};
  return {
    id,
    position: { x, y },
    data: {
      label,
      stepType,
      config
    }
  };
}
function normalizeEdge(input, index2) {
  if (!isRecord(input)) return null;
  const source = typeof input.source === "string" ? input.source : "";
  const target = typeof input.target === "string" ? input.target : "";
  if (!source || !target) return null;
  const id = typeof input.id === "string" && input.id.trim().length > 0 ? input.id : `${source}->${target}-${index2}`;
  return {
    id,
    source,
    target,
    ...typeof input.label === "string" && input.label.trim().length > 0 ? { label: input.label } : {}
  };
}
function humanizeStepType(stepType) {
  return stepType.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function createDefaultAgentGraph() {
  return {
    version: AGENT_GRAPH_VERSION,
    nodes: [
      {
        id: "input",
        position: { x: 120, y: 60 },
        data: {
          label: "Input",
          stepType: "input",
          config: {}
        }
      },
      {
        id: "decide",
        position: { x: 120, y: 200 },
        data: {
          label: "Decide Next Step",
          stepType: "decide",
          config: {}
        }
      },
      {
        id: "tool-batch",
        position: { x: 120, y: 340 },
        data: {
          label: "Tool Batch",
          stepType: "tool_batch",
          config: {}
        }
      },
      {
        id: "memory-write",
        position: { x: 120, y: 480 },
        data: {
          label: "Persist Memory",
          stepType: "memory_write",
          config: {}
        }
      },
      {
        id: "finish",
        position: { x: 120, y: 620 },
        data: {
          label: "Finish",
          stepType: "finish",
          config: {}
        }
      }
    ],
    edges: [
      { id: "input->decide", source: "input", target: "decide" },
      { id: "decide->tool-batch", source: "decide", target: "tool-batch" },
      {
        id: "tool-batch->memory-write",
        source: "tool-batch",
        target: "memory-write"
      },
      { id: "memory-write->finish", source: "memory-write", target: "finish" }
    ]
  };
}
function normalizeAgentGraph(input) {
  if (!isRecord(input)) {
    return createDefaultAgentGraph();
  }
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  const rawEdges = Array.isArray(input.edges) ? input.edges : [];
  const nodes = rawNodes.map((node, index2) => normalizeNode(node, index2)).filter((node) => node !== null);
  const edges = rawEdges.map((edge, index2) => normalizeEdge(edge, index2)).filter((edge) => edge !== null);
  return {
    version: input.version === AGENT_GRAPH_VERSION ? AGENT_GRAPH_VERSION : AGENT_GRAPH_VERSION,
    nodes: nodes.length > 0 ? nodes : createDefaultAgentGraph().nodes,
    edges
  };
}
function isAgentRef(value) {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || !value.id.trim()) return false;
  return true;
}
function getAgentTaskBody(taskConfig) {
  if (!isRecord(taskConfig)) {
    return createDefaultAgentTaskBody();
  }
  const withBlock = isRecord(taskConfig.with) ? taskConfig.with : {};
  const body = isRecord(withBlock.body) ? withBlock.body : {};
  const agentRefCandidate = body.agentRef ?? withBlock.agentRef;
  const agentRef = isAgentRef(agentRefCandidate) ? { id: agentRefCandidate.id, version: agentRefCandidate.version } : void 0;
  const overrides = sanitizeAgentOverrides(body.overrides ?? withBlock.overrides);
  const environmentRefCandidate = body.environmentRef ?? withBlock.environmentRef;
  const environmentRef = isEnvironmentRef(environmentRefCandidate) ? {
    id: environmentRefCandidate.id,
    version: environmentRefCandidate.version
  } : void 0;
  return {
    prompt: typeof body.prompt === "string" ? body.prompt : typeof withBlock.prompt === "string" ? withBlock.prompt : "",
    mode: "execute_direct",
    agentRuntime: typeof body.agentRuntime === "string" && body.agentRuntime.trim() ? body.agentRuntime.trim() : typeof withBlock.agentRuntime === "string" && withBlock.agentRuntime.trim() ? withBlock.agentRuntime.trim() : "dapr-agent-py",
    workspaceRef: typeof body.workspaceRef === "string" ? body.workspaceRef : typeof withBlock.workspaceRef === "string" ? withBlock.workspaceRef : void 0,
    sandboxName: typeof body.sandboxName === "string" ? body.sandboxName : typeof withBlock.sandboxName === "string" ? withBlock.sandboxName : void 0,
    cwd: typeof body.cwd === "string" ? body.cwd : typeof withBlock.cwd === "string" ? withBlock.cwd : void 0,
    maxTurns: typeof body.maxTurns === "number" ? body.maxTurns : typeof withBlock.maxTurns === "number" ? withBlock.maxTurns : void 0,
    timeoutMinutes: typeof body.timeoutMinutes === "number" ? body.timeoutMinutes : typeof withBlock.timeoutMinutes === "number" ? withBlock.timeoutMinutes : void 0,
    stopCondition: typeof body.stopCondition === "string" ? body.stopCondition : typeof withBlock.stopCondition === "string" ? withBlock.stopCondition : void 0,
    requireFileChanges: typeof body.requireFileChanges === "boolean" ? body.requireFileChanges : typeof withBlock.requireFileChanges === "boolean" ? withBlock.requireFileChanges : void 0,
    agentGraph: normalizeAgentGraph(body.agentGraph ?? withBlock.agentGraph),
    ...agentRef ? { agentRef } : {},
    ...environmentRef ? { environmentRef } : {},
    ...overrides ? { overrides } : {}
  };
}
function createDefaultAgentTaskBody(_label = "Agent") {
  return {
    prompt: "",
    mode: "execute_direct",
    agentRuntime: "dapr-agent-py",
    workspaceRef: "",
    sandboxName: "",
    cwd: "/sandbox",
    agentGraph: createDefaultAgentGraph()
  };
}
function normalizeAgentTaskConfig(taskConfig, label = "Agent") {
  const existing = stripPersonaFields(isRecord(taskConfig) ? taskConfig : {});
  const withBlock = stripPersonaFields(isRecord(existing.with) ? existing.with : {});
  const body = getAgentTaskBody(existing);
  const normalizedBody = {
    ...createDefaultAgentTaskBody(label),
    ...body,
    agentGraph: normalizeAgentGraph(body.agentGraph)
  };
  return {
    ...existing,
    call: "durable/run",
    with: {
      ...withBlock,
      prompt: normalizedBody.prompt,
      mode: normalizedBody.mode,
      agentRuntime: normalizedBody.agentRuntime,
      workspaceRef: normalizedBody.workspaceRef ?? "",
      sandboxName: normalizedBody.sandboxName ?? "",
      cwd: normalizedBody.cwd ?? "/sandbox",
      ...normalizedBody.maxTurns !== void 0 ? { maxTurns: normalizedBody.maxTurns } : {},
      ...normalizedBody.timeoutMinutes !== void 0 ? { timeoutMinutes: normalizedBody.timeoutMinutes } : {},
      ...normalizedBody.stopCondition ? { stopCondition: normalizedBody.stopCondition } : {},
      ...normalizedBody.requireFileChanges !== void 0 ? { requireFileChanges: normalizedBody.requireFileChanges } : {},
      agentGraph: normalizedBody.agentGraph,
      ...normalizedBody.agentRef ? { agentRef: normalizedBody.agentRef } : {},
      ...normalizedBody.environmentRef ? { environmentRef: normalizedBody.environmentRef } : {},
      body: normalizedBody
    }
  };
}
function isEnvironmentRef(value) {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || !value.id.trim()) return false;
  return true;
}

// src/lib/server/workflows/spec-builder.ts
function buildSpecFromGraph(workflowName, nodes, edges) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const edgesBySource = /* @__PURE__ */ new Map();
  for (const edge of edges) {
    const list = edgesBySource.get(edge.source) || [];
    list.push(edge);
    edgesBySource.set(edge.source, list);
  }
  const doArray = [];
  const visited = /* @__PURE__ */ new Set();
  let currentId = "__start__";
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = nodeMap.get(currentId);
    const nodeType = node?.data?.type || node?.type || "unknown";
    if (nodeType !== "start" && nodeType !== "end" && node) {
      const taskName = sanitizeTaskName(
        node.data?.label || node.id
      );
      const taskConfig = node.data?.taskConfig || {};
      const task = buildTask(nodeType, taskConfig, node);
      if (task) {
        doArray.push({ [taskName]: task });
      }
    }
    const outEdges = edgesBySource.get(currentId) || [];
    if (outEdges.length > 0) {
      currentId = outEdges[0].target;
    } else {
      break;
    }
  }
  return {
    document: {
      dsl: "1.0.0",
      namespace: "workflow-builder",
      name: sanitizeTaskName(workflowName),
      version: "1.0.0",
      title: workflowName
    },
    do: doArray
  };
}
function buildTask(nodeType, taskConfig, node) {
  switch (nodeType) {
    case "call": {
      if (taskConfig.call) {
        return taskConfig;
      }
      const fn = taskConfig.function;
      if (fn) {
        return {
          call: fn,
          with: taskConfig.arguments || {}
        };
      }
      return {
        call: "http",
        with: {
          method: taskConfig.method || "GET",
          endpoint: taskConfig.url || taskConfig.endpoint || ""
        }
      };
    }
    case "agent":
      return normalizeAgentTaskConfig(
        taskConfig,
        typeof node.data?.label === "string" ? node.data.label : node.id
      );
    case "set":
      return {
        set: taskConfig.variables || taskConfig
      };
    case "switch":
      return {
        switch: taskConfig.conditions || []
      };
    case "wait":
      return {
        wait: {
          duration: taskConfig.duration || "PT0S"
        }
      };
    case "emit":
      return {
        emit: {
          event: taskConfig.event || {}
        }
      };
    case "listen":
      return {
        listen: {
          to: taskConfig.event || {}
        }
      };
    case "for":
      return {
        for: {
          each: taskConfig.each || "item",
          in: taskConfig.in || ".items",
          do: taskConfig.do || []
        }
      };
    case "try":
      return {
        try: taskConfig.try || [],
        catch: taskConfig.catch || { errors: ["*"], do: [] }
      };
    case "raise":
      return {
        raise: {
          error: taskConfig.error || {
            status: 500,
            type: "error",
            title: "Error"
          }
        }
      };
    case "run":
      return {
        run: {
          command: taskConfig.command || "",
          args: taskConfig.args || []
        }
      };
    default:
      return taskConfig;
  }
}
function sanitizeTaskName(name) {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "task";
}

// lib/workflow-contract.ts
function resolveCanonicalWorkflowSpec(input) {
  const spec = buildSpecFromGraph(input.name, input.nodes, input.edges);
  if (input.description && typeof spec.document === "object" && spec.document) {
    spec.document.description = input.description;
  }
  return { specVersion: "1.0.0", spec };
}

// lib/workflows/normalize-nodes.ts
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function coerceConfigValuesToUiStrings(config) {
  const out = { ...config };
  for (const [key, value] of Object.entries(out)) {
    if (key === "actionType" || key === "integrationId" || key === "auth") {
      continue;
    }
    if (typeof value === "string" || value === void 0 || value === null) {
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value);
      continue;
    }
    if (typeof value === "object") {
      try {
        out[key] = JSON.stringify(value);
      } catch {
        out[key] = String(value);
      }
      continue;
    }
    out[key] = String(value);
  }
  return out;
}
function normalizeSystemHttpRequestConfig(config) {
  const out = { ...config };
  const endpoint = typeof out.endpoint === "string" ? out.endpoint : typeof out.url === "string" ? out.url : void 0;
  const httpMethod = typeof out.httpMethod === "string" ? out.httpMethod : typeof out.method === "string" ? out.method : void 0;
  const httpHeaders = out.httpHeaders !== void 0 ? out.httpHeaders : out.headers;
  const httpBody = out.httpBody !== void 0 ? out.httpBody : out.body;
  if (endpoint !== void 0) out.endpoint = endpoint;
  if (httpMethod !== void 0) out.httpMethod = httpMethod;
  if (httpHeaders !== void 0) out.httpHeaders = httpHeaders;
  if (httpBody !== void 0) out.httpBody = httpBody;
  if (out.url === void 0 && typeof endpoint === "string") out.url = endpoint;
  if (out.method === void 0 && typeof httpMethod === "string")
    out.method = httpMethod;
  if (out.headers === void 0 && httpHeaders !== void 0)
    out.headers = httpHeaders;
  if (out.body === void 0 && httpBody !== void 0) out.body = httpBody;
  return out;
}
function normalizeWorkflowNodes(nodes) {
  if (!Array.isArray(nodes)) return nodes;
  return nodes.map((node) => {
    if (!isObject(node)) return node;
    const current = node;
    const data = current.data;
    if (!data || !isObject(data)) return node;
    const nodeType = data.type ?? current.type ?? "";
    if (nodeType !== "action" && current.type !== "action") return node;
    const config = data.config;
    if (!config || !isObject(config)) return node;
    let nextConfig = coerceConfigValuesToUiStrings(config);
    if (nextConfig.actionType === "system/http-request") {
      nextConfig = normalizeSystemHttpRequestConfig(nextConfig);
    }
    return {
      ...node,
      data: {
        ...data,
        config: nextConfig
      }
    };
  });
}

// scripts/lib/project-system-workflows.ts
import { createHash } from "node:crypto";
function planProjectSystemWorkflowInstallations(input) {
  const owners = /* @__PURE__ */ new Map();
  for (const owner of input.owners) {
    const projectId = owner.projectId.trim();
    const userId = owner.userId.trim();
    if (!projectId || !userId || projectId === input.canonicalProjectId) continue;
    const current = owners.get(projectId);
    if (!current || userId < current) owners.set(projectId, userId);
  }
  return [...owners.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([projectId, userId]) => ({
    projectId,
    userId,
    workflowId: `${input.baseWorkflowId}-${createHash("sha256").update(`${input.baseWorkflowId}\0${projectId}`, "utf8").digest("hex").slice(0, 20)}`
  }));
}

// src/lib/server/agents/config-hash.ts
import { createHash as createHash2 } from "node:crypto";
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}
function hashAgentConfig(config) {
  return createHash2("sha256").update(canonicalJson(config)).digest("hex");
}
function canonicalize(value) {
  if (value === null || value === void 0) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== void 0).sort(([a], [b2]) => a < b2 ? -1 : a > b2 ? 1 : 0);
    const out = {};
    for (const [k, v] of entries) out[k] = canonicalize(v);
    return out;
  }
  return value;
}

// scripts/kimi-k3-browser-agent.ts
var KIMI_K3_BROWSER_AGENT_SLUG = "kimi-k3-browser-agent";
var KIMI_K3_BROWSER_PROBE_AGENT_SLUG = "kimi-k3-browser-probe-agent";
var LEGACY_BROWSER_AGENT_SLUG = "glm-browser-agent";
var LEGACY_BROWSER_PROBE_AGENT_SLUG = "glm-browser-probe-agent";
var BROWSER_MCP_URL = "http://agent-browser-mcp.workflow-builder.svc.cluster.local:8000/mcp";
var KIMI_K3_BROWSER_ALLOWED_TOOLS = [
  "browser_agent_browser_open",
  "browser_agent_browser_snapshot",
  "browser_agent_browser_click",
  "browser_agent_browser_fill",
  "browser_agent_browser_type",
  "browser_agent_browser_press",
  "browser_agent_browser_hover",
  "browser_agent_browser_select",
  "browser_agent_browser_highlight",
  "browser_agent_browser_scroll",
  "browser_agent_browser_back",
  "browser_agent_browser_wait_for_selector",
  "browser_agent_browser_wait_for_load",
  "browser_agent_browser_screenshot",
  "browser_agent_browser_get_text",
  "browser_agent_browser_get_url",
  "browser_agent_browser_get_title",
  "browser_agent_browser_pdf",
  "browser_agent_browser_close",
  "browser_demo_scene",
  "browser_agent_browser_console",
  "browser_agent_browser_errors"
];
var KIMI_K3_BROWSER_SYSTEM_PROMPT = 'You are a Kimi K3 vision browser automation agent. Your browser tools are MCP tools whose names begin with "browser_"; always call them by their exact names. Use browser_agent_browser_snapshot to discover stable accessibility-tree refs and browser_agent_browser_screenshot whenever visual appearance, layout, spacing, color, clipping, responsive behavior, or rendered state matters. Screenshot results are supplied directly to your vision model, while the platform also persists them as run artifacts. Use browser_agent_browser_open, click, fill, type, press, hover, select, scroll, back, wait, get_text, get_url, and get_title for navigation and interaction. Use browser_agent_browser_highlight immediately before an interaction the viewer should notice. browser_demo_scene marks the start of a recorded demo scene. The platform automatically records video and a network HAR; never start, stop, save, or upload recordings yourself. Work in short deliberate steps, do not repeat completed actions, and call browser_agent_browser_close when finished so capture is finalized. Report only concrete observations from DOM evidence and screenshots.';
function defaultBrowserMcpServer(probe) {
  return {
    name: "browser",
    transport: "streamable_http",
    url: BROWSER_MCP_URL,
    headers: {
      "X-Wfb-Target-Auth-Host": "workflow-builder:3000",
      ...probe ? { "X-Wfb-Browser-Lane": "per-node" } : {}
    }
  };
}
function executionSafeBrowserHeaders(headers, probe) {
  const retained = headers && typeof headers === "object" && !Array.isArray(headers) ? Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name.toLowerCase() !== "x-wfb-target-auth"
    )
  ) : {};
  if (probe) retained["X-Wfb-Browser-Lane"] = "per-node";
  return Object.keys(retained).length ? retained : void 0;
}
function buildKimiK3BrowserAgentConfig(sourceConfig, options) {
  const source = sourceConfig ? structuredClone(sourceConfig) : {};
  delete source.model;
  delete source.provider;
  delete source.thinking;
  delete source.llmComponent;
  delete source.providerModel;
  delete source.llm_component;
  delete source.provider_model;
  const sourceServers = Array.isArray(source.mcpServers) ? structuredClone(source.mcpServers) : [];
  const mcpServers2 = sourceServers.length ? sourceServers.map((entry) => {
    if (!entry || typeof entry !== "object" || !("url" in entry) || !String(entry.url).includes("agent-browser-mcp")) {
      return entry;
    }
    const { headers: sourceHeaders, ...server } = entry;
    const headers = executionSafeBrowserHeaders(
      sourceHeaders,
      options.probe
    );
    return { ...server, ...headers ? { headers } : {} };
  }) : [defaultBrowserMcpServer(options.probe)];
  return {
    ...source,
    systemPrompt: KIMI_K3_BROWSER_SYSTEM_PROMPT,
    runtime: "dapr-agent-py",
    runtimeClass: "coding",
    runtimeIsolation: "shared",
    modelSpec: "kimi/kimi-k3",
    reasoningEffort: "max",
    contextWindowTokens: 1048576,
    maxTurns: 120,
    timeoutMinutes: 120,
    builtinTools: [],
    tools: [],
    skills: [],
    memory: { backend: "dapr_state" },
    mcpConnectionMode: "auto",
    mcpServers: mcpServers2,
    allowedTools: [...KIMI_K3_BROWSER_ALLOWED_TOOLS],
    runtimeOverridePolicy: {
      allowToolNarrowing: true,
      allowServerAdditions: false,
      allowCredentialBinding: true,
      allowSkillAdditions: false,
      allowSkillNarrowing: true
    }
  };
}
var TEXT_REPLACEMENTS = [
  [LEGACY_BROWSER_PROBE_AGENT_SLUG, KIMI_K3_BROWSER_PROBE_AGENT_SLUG],
  [LEGACY_BROWSER_AGENT_SLUG, KIMI_K3_BROWSER_AGENT_SLUG],
  ["GLM 5.2 browser agent", "Kimi K3 vision browser agent"],
  ["GLM 5.2 + agent-browser", "Kimi K3 vision + agent-browser"],
  ["all-GLM/ZAI", "Kimi K3 vision/browser critic plus coding agent"],
  ["max ~10 tool calls TOTAL", "max ~14 tool calls TOTAL"],
  [
    "(2) browser_agent_browser_snapshot, (3) at most ONE obvious interaction",
    "(2) browser_agent_browser_snapshot, (3) browser_agent_browser_screenshot, (4) at most ONE obvious interaction"
  ],
  ["max ~8 tool calls TOTAL", "max ~12 tool calls TOTAL"],
  [
    "open each reference route ONCE + snapshot, open each target route ONCE + snapshot",
    "open each reference route ONCE + snapshot + screenshot, open each target route ONCE + snapshot + screenshot"
  ]
];
function migrateLegacyBrowserAgentReferences(value) {
  if (typeof value === "string") {
    return TEXT_REPLACEMENTS.reduce(
      (result, [from, to]) => result.replaceAll(from, to),
      value
    );
  }
  if (Array.isArray(value)) {
    return value.map(migrateLegacyBrowserAgentReferences);
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      migrateLegacyBrowserAgentReferences(entry)
    ])
  );
}
var BROWSER_AGENT_DEFINITIONS = [
  {
    slug: KIMI_K3_BROWSER_AGENT_SLUG,
    legacySlug: LEGACY_BROWSER_AGENT_SLUG,
    name: "Kimi K3 Vision Browser Agent",
    description: "Kimi K3 dapr-agent-py browser agent with native screenshot understanding, agent-browser MCP navigation, and durable browser artifacts.",
    probe: false
  },
  {
    slug: KIMI_K3_BROWSER_PROBE_AGENT_SLUG,
    legacySlug: LEGACY_BROWSER_PROBE_AGENT_SLUG,
    name: "Kimi K3 Vision Browser Probe Agent",
    description: "Kimi K3 dapr-agent-py browser probe with native screenshot understanding and per-node BrowserStation lane isolation.",
    probe: true
  }
];
async function ensureBrowserAgent(sql2, owner, definition) {
  const rows = await sql2`
		select a.id, av.version, av.config, av.config_hash,
			legacy_av.config as legacy_config
		from agents a
		left join agent_versions av on av.id = a.current_version_id
		left join agents legacy on legacy.slug = ${definition.legacySlug}
		left join agent_versions legacy_av on legacy_av.id = legacy.current_version_id
		where a.slug = ${definition.slug}
		limit 1
	`;
  const existing = rows[0];
  let legacyConfig = existing?.legacy_config ?? null;
  if (!existing) {
    const legacyRows = await sql2`
			select av.config
			from agents a
			left join agent_versions av on av.id = a.current_version_id
			where a.slug = ${definition.legacySlug}
			limit 1
		`;
    legacyConfig = legacyRows[0]?.config ?? null;
  }
  const config = buildKimiK3BrowserAgentConfig(
    existing?.config ?? legacyConfig,
    { probe: definition.probe }
  );
  const configHash = hashAgentConfig(config);
  const tags = ["dapr-agent-py", "kimi-k3", "vision", "browser"];
  if (existing?.id && existing.config_hash === configHash) {
    await sql2`
			update agents set
				name = ${definition.name}, description = ${definition.description},
				tags = ${sql2.json(tags)}, runtime = ${"dapr-agent-py"},
				registry_status = ${"registered"}, is_archived = false,
				updated_at = now()
			where id = ${existing.id}
		`;
    return;
  }
  const agentId = existing?.id ?? nanoid();
  const nextVersion = existing?.id ? Number(
    (await sql2`
						select coalesce(max(version), 0)::int as version
						from agent_versions where agent_id = ${existing.id}
					`)[0]?.version ?? 0
  ) + 1 : 1;
  const versionId = nanoid();
  await sql2.begin(async (transaction) => {
    const tx = transaction;
    if (!existing?.id) {
      await tx`
				insert into agents (
					id, slug, name, description, tags, runtime, created_by,
					project_id, registry_status, is_archived, default_vault_ids,
					created_at, updated_at
				) values (
					${agentId}, ${definition.slug}, ${definition.name},
					${definition.description}, ${sql2.json(tags)}, ${"dapr-agent-py"},
					${owner.userId}, ${owner.projectId}, ${"registered"}, false,
					${sql2.json([])}, now(), now()
				)
			`;
    }
    await tx`
			insert into agent_versions (
				id, agent_id, version, config, config_hash, changelog,
				published_at, published_by, created_at
			) values (
				${versionId}, ${agentId}, ${nextVersion},
				${sql2.json(config)}, ${configHash},
				${"Migrate browser automation to Kimi K3 vision with max reasoning and a 1M-token context window."},
				now(), ${owner.userId}, now()
			)
		`;
    await tx`
			update agents set
				name = ${definition.name}, description = ${definition.description},
				tags = ${sql2.json(tags)}, runtime = ${"dapr-agent-py"},
				registry_status = ${"registered"}, is_archived = false,
				current_version_id = ${versionId}, updated_at = now()
			where id = ${agentId}
		`;
  });
}
async function migrateKimiK3BrowserAgentsAndWorkflows(sql2, owner) {
  for (const definition of BROWSER_AGENT_DEFINITIONS) {
    await ensureBrowserAgent(sql2, owner, definition);
  }
  const workflowRows = await sql2`
		select id, name, description, spec, nodes, edges
		from workflows
		where coalesce(spec::text, '') like ${`%${LEGACY_BROWSER_AGENT_SLUG}%`}
			or coalesce(spec::text, '') like ${`%${LEGACY_BROWSER_PROBE_AGENT_SLUG}%`}
			or coalesce(nodes::text, '') like ${`%${LEGACY_BROWSER_AGENT_SLUG}%`}
			or coalesce(nodes::text, '') like ${`%${LEGACY_BROWSER_PROBE_AGENT_SLUG}%`}
			or coalesce(edges::text, '') like ${`%${LEGACY_BROWSER_AGENT_SLUG}%`}
			or coalesce(edges::text, '') like ${`%${LEGACY_BROWSER_PROBE_AGENT_SLUG}%`}
			or name in (${"gan-ui-logic-test"}, ${"site-demo-video"}, ${"agent-browser-smoke"})
	`;
  let workflowsUpdated = 0;
  for (const workflow of workflowRows) {
    const migratedName = migrateLegacyBrowserAgentReferences(
      workflow.name
    );
    const migratedDescription = workflow.description ? migrateLegacyBrowserAgentReferences(workflow.description) : null;
    const migratedSpec = migrateLegacyBrowserAgentReferences(workflow.spec);
    const migratedNodes = migrateLegacyBrowserAgentReferences(workflow.nodes);
    const migratedEdges = migrateLegacyBrowserAgentReferences(workflow.edges);
    if (migratedName === workflow.name && migratedDescription === workflow.description && JSON.stringify(migratedSpec) === JSON.stringify(workflow.spec) && JSON.stringify(migratedNodes) === JSON.stringify(workflow.nodes) && JSON.stringify(migratedEdges) === JSON.stringify(workflow.edges)) {
      continue;
    }
    await sql2`
			update workflows set
				name = ${migratedName},
				description = ${migratedDescription},
				spec = ${sql2.json(migratedSpec)},
				nodes = ${sql2.json(migratedNodes)},
				edges = ${sql2.json(migratedEdges)},
				updated_at = now()
			where id = ${workflow.id}
		`;
    workflowsUpdated += 1;
  }
  const remainingRows = await sql2`
		select count(*)::int as count from workflows
		where coalesce(spec::text, '') like ${`%${LEGACY_BROWSER_AGENT_SLUG}%`}
			or coalesce(spec::text, '') like ${`%${LEGACY_BROWSER_PROBE_AGENT_SLUG}%`}
			or coalesce(nodes::text, '') like ${`%${LEGACY_BROWSER_AGENT_SLUG}%`}
			or coalesce(nodes::text, '') like ${`%${LEGACY_BROWSER_PROBE_AGENT_SLUG}%`}
			or coalesce(edges::text, '') like ${`%${LEGACY_BROWSER_AGENT_SLUG}%`}
			or coalesce(edges::text, '') like ${`%${LEGACY_BROWSER_PROBE_AGENT_SLUG}%`}
	`;
  if (Number(remainingRows[0]?.count ?? 0) > 0) {
    throw new Error(
      "Refusing to archive GLM browser agents while workflow references remain."
    );
  }
  await sql2`
		update agents set is_archived = true, updated_at = now()
		where slug in (${LEGACY_BROWSER_AGENT_SLUG}, ${LEGACY_BROWSER_PROBE_AGENT_SLUG})
	`;
  console.log(
    `[seed-workflows] Reconciled Kimi K3 vision browser agents; migrated ${workflowsUpdated} workflow(s) and archived the GLM browser definitions`
  );
  return { workflowsUpdated };
}

// scripts/upsert-3b1b-animation-workflow.ts
import { pathToFileURL } from "node:url";
var DATABASE_URL = process.env.DATABASE_URL;
var WORKFLOW_ID = process.env.WORKFLOW_ID || "three-b-one-b-skill-animation";
var WORKFLOW_NAME = process.env.WORKFLOW_NAME || "3Blue1Brown-style Animation";
var WORKFLOW_DESCRIPTION = process.env.WORKFLOW_DESCRIPTION || "Generate a self-contained browser animation in the 3Blue1Brown style (Canvas/SVG, no Manim) inside a retained per-run sandbox, then capture screenshots of the play/restart interaction via browser/validate.";
var KIMI_AGENT_SLUG = "kimi-k3-3b1b-animation-builder";
var KIMI_AGENT_NAME = "Kimi K3 3B1B Animation Builder";
var KIMI_AGENT_DESCRIPTION = "Dapr Agents coding agent for building self-contained 3Blue1Brown-style browser animations with Kimi K3.";
var KIMI_AGENT_CONFIG = {
  systemPrompt: "You build polished, self-contained mathematical browser animations. Work directly in the supplied sandbox, prefer Canvas or SVG with plain HTML/CSS/JavaScript, preserve the requested stable DOM ids, and verify the generated files before finishing.",
  runtime: "dapr-agent-py",
  runtimeClass: "coding",
  runtimeIsolation: "shared",
  modelSpec: "kimi/kimi-k3",
  reasoningEffort: "max",
  contextWindowTokens: 1048576,
  maxTurns: 60,
  timeoutMinutes: 60,
  cwd: "/sandbox",
  builtinTools: [
    "execute_command",
    "read_file",
    "write_file",
    "edit_file",
    "list_files",
    "glob_files",
    "grep_search"
  ],
  tools: [],
  mcpConnectionMode: "explicit",
  mcpServers: [],
  skills: [],
  memory: { backend: "dapr_state" },
  runtimeOverridePolicy: {
    allowToolNarrowing: true,
    allowServerAdditions: false,
    allowCredentialBinding: true,
    allowSkillAdditions: false,
    allowSkillNarrowing: true
  }
};
function parseArgs(argv) {
  let userEmail = "";
  let agentId = "";
  let agentVersion;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--user-email") {
      userEmail = String(argv[i + 1] || "").trim();
      i += 1;
    } else if (argv[i] === "--agent-id") {
      agentId = String(argv[i + 1] || "").trim();
      i += 1;
    } else if (argv[i] === "--agent-version") {
      agentVersion = Number(String(argv[i + 1] || "").trim());
      i += 1;
    }
  }
  if (agentVersion !== void 0 && (!Number.isInteger(agentVersion) || agentVersion <= 0)) {
    throw new Error("--agent-version must be a positive integer");
  }
  if (agentVersion !== void 0 && !agentId) {
    throw new Error("--agent-version requires --agent-id");
  }
  return {
    userEmail,
    ...agentId ? { agentOverride: { id: agentId, version: agentVersion } } : {}
  };
}
async function resolveOwner(sql2, existing, userEmail) {
  if (existing?.user_id) {
    return {
      userId: String(existing.user_id),
      projectId: existing.project_id ? String(existing.project_id) : null
    };
  }
  if (userEmail) {
    const rows = await sql2`
      select u.id as user_id, pm.project_id
      from users u
      left join project_members pm on pm.user_id = u.id
      where lower(u.email) = lower(${userEmail})
      order by pm.created_at asc nulls last
      limit 1
    `;
    if (rows[0]?.user_id) {
      return {
        userId: String(rows[0].user_id),
        projectId: rows[0].project_id ? String(rows[0].project_id) : null
      };
    }
  }
  const memberRows = await sql2`
    select pm.user_id, pm.project_id
    from project_members pm
    order by pm.created_at asc
    limit 1
  `;
  if (memberRows[0]?.user_id) {
    return {
      userId: String(memberRows[0].user_id),
      projectId: memberRows[0].project_id ? String(memberRows[0].project_id) : null
    };
  }
  const userRows = await sql2`
    select id as user_id
    from users
    order by created_at asc
    limit 1
  `;
  if (userRows[0]?.user_id) {
    return { userId: String(userRows[0].user_id), projectId: null };
  }
  throw new Error("Could not resolve a workflow owner.");
}
function hashConfig(config) {
  return hashAgentConfig(config);
}
async function ensureKimiAgent(sql2, owner) {
  const config = KIMI_AGENT_CONFIG;
  const configHash = hashConfig(config);
  const existingRows = await sql2`
    select a.id, av.version, av.config_hash
    from agents a
    left join agent_versions av on av.id = a.current_version_id
    where a.slug = ${KIMI_AGENT_SLUG}
    limit 1
  `;
  const existing = existingRows[0];
  if (existing?.id && existing.config_hash === configHash) {
    await sql2`
      update agents
      set
        name = ${KIMI_AGENT_NAME},
        description = ${KIMI_AGENT_DESCRIPTION},
        tags = ${sql2.json(["dapr-agent-py", "kimi-k3", "animation", "3b1b"])},
        runtime = ${"dapr-agent-py"},
        registry_status = ${"registered"},
        is_archived = false,
        updated_at = now()
      where id = ${existing.id}
        and (
          name is distinct from ${KIMI_AGENT_NAME}
          or description is distinct from ${KIMI_AGENT_DESCRIPTION}
          or tags is distinct from ${sql2.json(["dapr-agent-py", "kimi-k3", "animation", "3b1b"])}::jsonb
          or runtime is distinct from ${"dapr-agent-py"}
          or registry_status is distinct from ${"registered"}
          or is_archived is distinct from false
        )
    `;
    return { id: String(existing.id), version: Number(existing.version) };
  }
  if (existing?.id) {
    const versionRows = await sql2`
      select coalesce(max(version), 0)::int as version
      from agent_versions
      where agent_id = ${existing.id}
    `;
    const nextVersion = Number(versionRows[0]?.version ?? 0) + 1;
    const versionId2 = nanoid();
    await sql2.begin(async (transaction) => {
      const tx = transaction;
      await tx`
        insert into agent_versions (
          id, agent_id, version, config, config_hash,
          changelog, published_at, published_by, created_at
        ) values (
          ${versionId2}, ${existing.id}, ${nextVersion},
          ${sql2.json(config)}, ${configHash},
          ${"Reconcile the 3B1B animation agent to Kimi K3 with max reasoning and a 1M-token context window."},
          now(), ${owner.userId}, now()
        )
      `;
      await tx`
        update agents
        set
          name = ${KIMI_AGENT_NAME},
          description = ${KIMI_AGENT_DESCRIPTION},
          tags = ${sql2.json(["dapr-agent-py", "kimi-k3", "animation", "3b1b"])},
          runtime = ${"dapr-agent-py"},
          registry_status = ${"registered"},
          is_archived = false,
          current_version_id = ${versionId2},
          updated_at = now()
        where id = ${existing.id}
      `;
    });
    return { id: String(existing.id), version: nextVersion };
  }
  const agentId = nanoid();
  const versionId = nanoid();
  await sql2.begin(async (transaction) => {
    const tx = transaction;
    await tx`
      insert into agents (
        id, slug, name, description, tags, runtime,
        created_by, project_id, registry_status, is_archived,
        default_vault_ids, created_at, updated_at
      ) values (
        ${agentId}, ${KIMI_AGENT_SLUG}, ${KIMI_AGENT_NAME},
        ${KIMI_AGENT_DESCRIPTION},
        ${sql2.json(["dapr-agent-py", "kimi-k3", "animation", "3b1b"])},
        ${"dapr-agent-py"}, ${owner.userId}, ${owner.projectId},
        ${"registered"}, false, ${sql2.json([])}, now(), now()
      )
    `;
    await tx`
      insert into agent_versions (
        id, agent_id, version, config, config_hash,
        changelog, published_at, published_by, created_at
      ) values (
        ${versionId}, ${agentId}, 1,
        ${sql2.json(config)}, ${configHash},
        ${"Initial Kimi K3 definition for the 3B1B animation workflow."},
        now(), ${owner.userId}, now()
      )
    `;
    await tx`
      update agents
      set current_version_id = ${versionId}, updated_at = now()
      where id = ${agentId}
    `;
  });
  return { id: agentId, version: 1 };
}
async function resolveAgentOverride(sql2, override) {
  const rows = override.version !== void 0 ? await sql2`
          select a.id, av.version
          from agents a
          join agent_versions av on av.agent_id = a.id
          where a.id = ${override.id} and av.version = ${override.version}
          limit 1
        ` : await sql2`
          select a.id, av.version
          from agents a
          join agent_versions av on av.id = a.current_version_id
          where a.id = ${override.id}
          limit 1
        `;
  if (!rows[0]?.id) {
    throw new Error(
      `Could not resolve published agent ${override.id}${override.version !== void 0 ? ` version ${override.version}` : ""}`
    );
  }
  return { id: String(rows[0].id), version: Number(rows[0].version) };
}
var APP_DIR = "/sandbox/3b1b-style-animation-example";
var BUILD_OUTPUT_SANDBOX_NAME = '${ .workspace_profile.sandboxName // "" }';
var BUILD_OUTPUT_WORKSPACE_REF = "${ .workspace_profile.workspaceRef }";
function makeWorkspaceProfileTask() {
  return {
    call: "workspace/profile",
    with: {
      name: "three-b-one-b-animation",
      rootPath: "/sandbox",
      sandboxTemplate: '${ .trigger.sandboxTemplate // "dapr-agent" }',
      ttlSeconds: 7200,
      keepAfterRun: true,
      managedBy: "workflow-builder:demos:3b1b-animation",
      commandTimeoutMs: 9e5,
      timeoutMs: 12e5,
      enabledTools: [
        "execute_command",
        "read_file",
        "write_file",
        "edit_file",
        "list_files",
        "mkdir",
        "file_stat"
      ],
      sandboxPolicy: {
        mode: "per-run",
        template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
        ttlSeconds: 7200,
        keepAfterRun: true
      }
    }
  };
}
var BUILD_PROMPT_PARTS = [
  '${ .trigger.animationDescription + " \u2014 Build a self-contained browser animation in ',
  APP_DIR,
  " with index.html, styles.css, script.js, and README.md. ",
  "Use Canvas or SVG so the result runs via a simple static file server. ",
  "The browser animation is the required deliverable. ",
  'Use stable DOM ids for validation: the main canvas must be <canvas id=\\"canvas\\">, ',
  'the play/pause control <button id=\\"btn-play\\">, ',
  'the restart control <button id=\\"btn-restart\\">. ',
  "Do NOT install Manim \u2014 if a scene is useful, include scene.py as optional source only. ",
  "Do not start any preview server; the downstream browser/validate and ",
  "browser/start-preview steps will do that. ",
  "The page must work when served as static files (no module imports outside relative script.js). ",
  "Do NOT create a package.json \u2014 that triggers the runtime's npm-run-dev fallback ",
  "which expects flags python3's http.server doesn't recognize. ",
  'Final answer: list the files created and a one-paragraph outline of the animation logic." }'
];
var BUILD_PROMPT = BUILD_PROMPT_PARTS.join("");
function makeBuildAnimationTask(agentRef) {
  return {
    call: "durable/run",
    with: {
      mode: "execute_direct",
      cwd: "/sandbox",
      sandboxName: "${ .workspace_profile.sandboxName }",
      workspaceRef: "${ .workspace_profile.workspaceRef }",
      outputSync: {
        workspaceRef: "${ .workspace_profile.workspaceRef }",
        paths: [
          {
            source: APP_DIR,
            target: APP_DIR
          }
        ],
        timeoutMs: 12e4
      },
      sandboxPolicy: {
        mode: "per-run",
        template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
        ttlSeconds: 7200,
        keepAfterRun: true
      },
      body: {
        agentRef,
        prompt: BUILD_PROMPT,
        overrides: {
          cwd: "/sandbox",
          maxTurns: 60,
          timeoutMinutes: 60
        }
      }
    }
  };
}
function makeStartPreviewTask() {
  return {
    call: "browser/start-preview",
    with: {
      body: {
        input: {
          previewId: '${ "3b1b-animation-preview-" + (.runtime.dbExecutionId // .workspace_profile.workspaceRef) }',
          repoPath: APP_DIR,
          rootPath: "/sandbox",
          workingDir: "/sandbox",
          // Same omit-devServerCommand pattern as browser/validate — runtime
          // detects index.html and runs `python3 -m http.server {port} --bind 0.0.0.0`.
          baseUrl: "http://127.0.0.1:0",
          keepAlive: true,
          timeoutSeconds: 7200,
          timeoutMs: 72e5,
          sandboxName: BUILD_OUTPUT_SANDBOX_NAME,
          workspaceRef: BUILD_OUTPUT_WORKSPACE_REF
        }
      }
    }
  };
}
function makeBrowserValidateTask() {
  return {
    call: "browser/validate",
    with: {
      workspaceRef: BUILD_OUTPUT_WORKSPACE_REF,
      sandboxName: BUILD_OUTPUT_SANDBOX_NAME,
      repoPath: APP_DIR,
      // Skip installCommand + devServerCommand. The runtime's default
      // `_local_devserver_runner` detects index.html in repoPath and runs
      // `python3 -m http.server {port} --bind 0.0.0.0` against a port it
      // allocates itself. baseUrl's port is rewritten to match. Mirrors
      // the canonical animation-3b1b-v2-managed.workflow.json shape and
      // avoids the runtime/command port mismatch that broke our prior
      // canaries OQK3 / FSOMOoo9 / Z1ebywvI / X3EZ5moY / Oa8AnQiR.
      installCommand: "",
      baseUrl: "http://127.0.0.1:0",
      steps: [
        {
          id: "initial",
          label: "Animation loaded",
          action: "visit",
          path: "/",
          goal: "Initial render of the canvas before any interaction.",
          waitForSelector: "canvas#canvas",
          pauseMs: 1500,
          fullPage: true
        },
        {
          id: "after-play",
          label: "After play",
          action: "click",
          selector: "button#btn-play",
          goal: "Trigger the play control once.",
          waitForSelector: "canvas#canvas",
          pauseMs: 2e3,
          fullPage: true
        },
        {
          id: "after-second-play",
          label: "After second play",
          action: "click",
          selector: "button#btn-play",
          goal: "Trigger the play control again to capture mid-animation state.",
          waitForSelector: "canvas#canvas",
          pauseMs: 1500,
          fullPage: true
        },
        {
          id: "after-restart",
          label: "After restart",
          action: "click",
          selector: "button#btn-restart",
          goal: "Restart the animation and capture the reset state.",
          waitForSelector: "canvas#canvas",
          pauseMs: 1500,
          fullPage: true
        }
      ],
      captureVideo: true,
      captureTrace: true,
      viewportPreset: "desktop",
      captureMode: "demo",
      demoTitle: '${ "3Blue1Brown-style animation: " + .trigger.animationDescription }',
      demoSummary: "Generated 3Blue1Brown-style browser animation; browser/validate captured initial / play / second play / restart states from the retained per-run sandbox.",
      metadata: {
        appPath: APP_DIR,
        workflowStage: "post-3b1b-animation",
        runtimeSandboxName: "${ .build_3b1b_animation.runtimeSandboxName // null }"
      },
      timeoutMs: 9e5
    }
  };
}
function buildSpec(agentRef) {
  return {
    document: {
      dsl: "1.0.0",
      namespace: "workflow-builder.demos",
      name: WORKFLOW_ID,
      version: "1.0.0",
      title: WORKFLOW_NAME,
      summary: WORKFLOW_DESCRIPTION,
      "x-workflow-builder": {
        architecture: "per-agent-runtime+session-workflow-bridge+browser-validate-capture",
        notes: "Adapted from the legacy 3pvh53PpHSiz-OoEeSW4z fixture for the per-agent-runtime architecture. Single agent step builds index.html / styles.css / script.js / README.md; browser/validate boots `python3 -m http.server` and captures a 4-screenshot demo (initial / play\xD72 / restart). Sandbox is retained (keepAfterRun=true) so the live preview proxy can attach after completion.",
        triggerInputs: {
          animationDescription: "Required. Plain-language description of the 3Blue1Brown-style animation to build (e.g. 'derivative of x^2', 'epsilon-delta limit visualization').",
          sandboxTemplate: "Optional override (default 'dapr-agent'). Only set this if the cluster has a dedicated animation template installed."
        },
        input: {
          fields: {
            animationDescription: {
              type: "textarea",
              label: "Animation description",
              description: "Describe the 3Blue1Brown-style animation the agent should build.",
              defaultValue: "Create a concise 3Blue1Brown-style derivative animation for x^2"
            }
          }
        }
      }
    },
    do: [
      { workspace_profile: makeWorkspaceProfileTask() },
      { build_3b1b_animation: makeBuildAnimationTask(agentRef) },
      { browser_validate_capture: makeBrowserValidateTask() },
      { start_preview: makeStartPreviewTask() }
    ],
    output: {
      as: {
        appPath: APP_DIR,
        workspaceRef: BUILD_OUTPUT_WORKSPACE_REF,
        sandboxName: BUILD_OUTPUT_SANDBOX_NAME,
        runtimeSandboxName: "${ .build_3b1b_animation.runtimeSandboxName // null }",
        animation: "${ .build_3b1b_animation }",
        screenshots: "${ .browser_validate_capture }",
        preview: "${ .start_preview }"
      }
    },
    input: {
      schema: {
        document: {
          type: "object",
          required: ["animationDescription"],
          properties: {
            animationDescription: {
              type: "string",
              title: "Animation description",
              description: "Describe the 3Blue1Brown-style animation the agent should build.",
              default: "Create a concise 3Blue1Brown-style derivative animation for x^2"
            }
          }
        },
        format: "json"
      }
    }
  };
}
function buildNodes() {
  return [
    {
      id: "trigger",
      type: "trigger",
      position: { x: 80, y: 60 },
      data: {
        label: "Animation request trigger",
        description: "Receives animationDescription (plain-language description of the 3Blue1Brown-style animation to build)."
      }
    },
    {
      id: "workspace_profile",
      type: "action",
      position: { x: 80, y: 200 },
      data: {
        label: "Provision retained sandbox",
        actionType: "workspace/profile",
        description: "Stand up a per-run sandbox with file/exec tools; keepAfterRun=true so the live preview can attach after the run."
      }
    },
    {
      id: "build_3b1b_animation",
      type: "action",
      position: { x: 80, y: 340 },
      data: {
        label: "Build 3B1B animation",
        actionType: "durable/run",
        description: "Agent generates index.html / styles.css / script.js / README.md in /sandbox/3b1b-style-animation-example with stable DOM ids (canvas#canvas, button#btn-play, button#btn-restart) so browser/validate can wire screenshots reliably."
      }
    },
    {
      id: "browser_validate_capture",
      type: "action",
      position: { x: 80, y: 480 },
      data: {
        label: "Capture animation walkthrough",
        actionType: "browser/validate",
        description: "Boot `python3 -m http.server` against the generated static files and capture initial / play\xD72 / restart screenshots."
      }
    },
    {
      id: "start_preview",
      type: "action",
      position: { x: 80, y: 620 },
      data: {
        label: "Start live preview",
        actionType: "browser/start-preview",
        description: "Pre-create the live-preview proxy with correct repoPath/rootPath so the UI's preview button connects to a ready-to-serve instance instead of spawning a racy lazy one."
      }
    }
  ];
}
function buildEdges() {
  return [
    {
      id: "e1",
      source: "trigger",
      target: "workspace_profile",
      type: "default"
    },
    {
      id: "e2",
      source: "workspace_profile",
      target: "build_3b1b_animation",
      type: "default"
    },
    {
      id: "e3",
      source: "build_3b1b_animation",
      target: "browser_validate_capture",
      type: "default"
    },
    {
      id: "e4",
      source: "browser_validate_capture",
      target: "start_preview",
      type: "default"
    }
  ];
}
async function main() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  const args = parseArgs(process.argv.slice(2));
  const sql2 = src_default(DATABASE_URL, { max: 1, prepare: false });
  try {
    const existingRows = await sql2`
      select user_id, project_id
      from workflows
      where id = ${WORKFLOW_ID}
      limit 1
    `;
    const owner = await resolveOwner(sql2, existingRows[0], args.userEmail);
    const agentRef = args.agentOverride ? await resolveAgentOverride(sql2, args.agentOverride) : await ensureKimiAgent(sql2, owner);
    const spec = buildSpec(agentRef);
    const nodes = buildNodes();
    const edges = buildEdges();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await sql2`
      insert into workflows (
        id,
        name,
        description,
        user_id,
        project_id,
        nodes,
        edges,
        visibility,
        engine_type,
        spec_version,
        spec,
        created_at,
        updated_at
      )
      values (
        ${WORKFLOW_ID},
        ${WORKFLOW_NAME},
        ${WORKFLOW_DESCRIPTION},
        ${owner.userId},
        ${owner.projectId},
        ${sql2.json(nodes)},
        ${sql2.json(edges)},
        ${"public"},
        ${"dapr"},
        ${"1.0.0"},
        ${sql2.json(spec)},
        ${now},
        ${now}
      )
      on conflict (id) do update
      set
        name = excluded.name,
        description = excluded.description,
        nodes = excluded.nodes,
        edges = excluded.edges,
        visibility = excluded.visibility,
        engine_type = excluded.engine_type,
        spec_version = excluded.spec_version,
        spec = excluded.spec,
        updated_at = excluded.updated_at
    `;
    console.log(`Upserted workflow ${WORKFLOW_ID}`);
    console.log(
      `  agentRef        = { id: '${agentRef.id}', version: ${agentRef.version} }`
    );
    console.log(
      `  agent source    = ${args.agentOverride ? "explicit override" : KIMI_AGENT_SLUG}`
    );
    console.log(`  owner.userId    = ${owner.userId}`);
    console.log(`  owner.projectId = ${owner.projectId ?? "(none)"}`);
    console.log(`  visibility      = public`);
    console.log(`  UI route        : /workflows/${WORKFLOW_ID}`);
  } finally {
    await sql2.end({ timeout: 5 });
  }
}
var invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error("[upsert-3b1b-animation-workflow] Error:", error);
    process.exitCode = 1;
  });
}

// scripts/seed-workflows.ts
var DATABASE_URL2 = process.env.DATABASE_URL || "postgres://localhost:5432/workflow";
var WORKFLOW_ID2 = "lazxidq045szbb9ke4dny";
var WORKFLOW_NAME2 = "Opencode Agent Plan Then Execute PR";
var WORKFLOW_DESCRIPTION2 = "Multi-step opencode flow: planning, execution, change verification, then commit/push/PR";
var AI_CODING_AGENT_WORKFLOW_ID = "aicodingagent001";
var AI_CODING_AGENT_WORKFLOW_NAME = "AI Coding Agent";
var AI_CODING_AGENT_WORKFLOW_DESCRIPTION = "System workflow for ai/main coding sessions. Clones the selected repository into a sandbox, creates an OpenShell coding plan, waits for approval, and then executes the approved plan in the same run.";
var OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_ID = "2mjd2mrptkf8zaxembsbp";
var OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_NAME = "OpenShell Feature Delivery";
var OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_DESCRIPTION = "Reusable OpenShell plan-first coding workflow for user-supplied feature requests.";
var OPENSHELL_LANGGRAPH_BROWSER_VALIDATION_REPOSITORY_URL = "https://github.com/PittampalliOrg/next-learn.git";
var GITHUB_SANDBOX_CLONE_PROOF_WORKFLOW_ID = "ghsbxcloneproof001";
var GITHUB_SANDBOX_CLONE_PROOF_WORKFLOW_NAME = "GitHub Sandbox Clone Proof";
var GITHUB_SANDBOX_CLONE_PROOF_WORKFLOW_DESCRIPTION = "Reference workflow that clones PittampalliOrg/workflow-builder into a Kubernetes sandbox and prints a directory tree.";
var GITHUB_SANDBOX_REVIEW_WORKFLOW_ID = "ghsbxreviewproof001";
var GITHUB_SANDBOX_REVIEW_WORKFLOW_NAME = "GitHub Sandbox Project Review";
var GITHUB_SANDBOX_REVIEW_WORKFLOW_DESCRIPTION = "Reference workflow that clones PittampalliOrg/workflow-builder into a Kubernetes sandbox, prints a directory tree, and asks the OpenShell coding agent to review and summarize the project.";
var AGENT_SYSTEM_DEMO_WORKFLOW_ID = "agentsysdemo001";
var AGENT_SYSTEM_DEMO_WORKFLOW_NAME = "OpenShell Feature Delivery Demo";
var AGENT_SYSTEM_DEMO_WORKFLOW_DESCRIPTION = "Demo workflow for the Workflow Builder UI that clones PittampalliOrg/stacks and runs an OpenShell-backed plan, approval, and implementation loop that emits code artifacts.";
var THREE_B_ONE_B_WORKFLOW_ID = "three-b-one-b-skill-animation";
var THREE_B_ONE_B_WORKFLOW_NAME = "3Blue1Brown-style Animation";
var THREE_B_ONE_B_WORKFLOW_DESCRIPTION = "Generate a self-contained browser animation in the 3Blue1Brown style (Canvas/SVG, no Manim) inside a retained per-run sandbox, then capture screenshots of the play/restart interaction via browser/validate.";
var THREE_B_ONE_B_CLI_WORKFLOW_ID = process.env.SEED_3B1B_CLI_WORKFLOW_ID?.trim() || "three-b-one-b-skill-animation-cli";
var THREE_B_ONE_B_CLI_WORKFLOW_NAME = process.env.SEED_3B1B_CLI_WORKFLOW_NAME?.trim() || "3Blue1Brown-style Animation (CLI agents)";
var THREE_B_ONE_B_CLI_WORKFLOW_DESCRIPTION = process.env.SEED_3B1B_CLI_WORKFLOW_DESCRIPTION?.trim() || "Generate a self-contained browser animation in the 3Blue1Brown style using a runtime-selected CLI agent, then verify, capture, and preview the copied app files from the retained workspace.";
var THREE_B_ONE_B_APP_DIR = "/sandbox/3b1b-style-animation-example";
var THREE_B_ONE_B_BUILD_OUTPUT_SANDBOX_NAME = '${ .workspace_profile.sandboxName // "" }';
var THREE_B_ONE_B_BUILD_OUTPUT_WORKSPACE_REF = "${ .workspace_profile.workspaceRef }";
var THREE_B_ONE_B_AGENT_OVERRIDE_ID = process.env.SEED_3B1B_AGENT_ID?.trim() || "";
var THREE_B_ONE_B_AGENT_OVERRIDE_VERSION = Number(
  process.env.SEED_3B1B_AGENT_VERSION?.trim() || "1"
);
var PREVIEW_HMR_GATE_FUNCTION_ID = "codefn_preview_hmr_gate";
var PREVIEW_HMR_GATE_SLUG = "preview-hmr-gate";
var PREVIEW_HMR_GATE_VERSION = "1.0.0";
var PREVIEW_HMR_GATE_SOURCE = String.raw`
import io
import tarfile
import time
import urllib.error
import urllib.request


def _request(url, *, token=None, timeout=30):
    headers = {}
    if token:
        headers["x-sync-token"] = token
    req = urllib.request.Request(url, headers=headers)
    return urllib.request.urlopen(req, timeout=timeout)


def _http_code(url, timeout=20):
    try:
        with _request(url, timeout=timeout) as res:
            body = res.read(512_000).decode("utf-8", "replace")
            return res.status, body
    except urllib.error.HTTPError as exc:
        body = exc.read(512_000).decode("utf-8", "replace")
        return exc.code, body
    except Exception as exc:
        return 0, str(exc)


def main(config):
    export_url = str(config.get("exportUrl") or "")
    token = str(config.get("syncCapability") or "")
    preview_url = str(config.get("previewUrl") or "").rstrip("/")
    routes = config.get("routes") if isinstance(config.get("routes"), list) else ["/dashboard"]
    if not export_url or not token or not preview_url:
        raise RuntimeError("gate configuration is incomplete")

    with _request(export_url, token=token, timeout=45) as res:
        archive = res.read()
        generation = res.headers.get("x-sync-generation") or ""
    if not archive:
        raise RuntimeError("sidecar export returned no source archive")

    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        names = set(tar.getnames())
        if "src/routes/dashboard/+page.svelte" not in names:
            raise RuntimeError("dashboard page source is missing from sidecar export")
        dashboard = tar.extractfile("src/routes/dashboard/+page.svelte").read().decode("utf-8", "replace")
    if not dashboard.strip():
        raise RuntimeError("dashboard page source is empty")
    if not generation:
        raise RuntimeError("sidecar export did not report a live-sync generation")

    health_status = 0
    health_body = ""
    for _ in range(45):
        health_status, health_body = _http_code(f"{preview_url}/api/health", timeout=10)
        if health_status == 200:
            break
        time.sleep(2)
    if health_status != 200:
        raise RuntimeError(f"preview health did not become ready: {health_status} {health_body[:200]}")

    route_results = []
    for route in routes:
        path = str(route or "/")
        status, body = _http_code(f"{preview_url}{path}", timeout=20)
        route_results.append({"route": path, "status": status})
        if status == 500:
            raise RuntimeError(f"{path} returned HTTP 500")
        if "ReferenceError" in body or "each_key_duplicate" in body:
            raise RuntimeError(f"{path} contains a client/runtime error marker")

    return {
        "accepted": True,
        "summary": "exported dashboard source, observed live-sync generation, and checked preview routes",
        "generation": generation,
        "routes": route_results,
    }
`;
var SVELTEKIT_GAME_WORKFLOW_ID = process.env.SEED_SVELTEKIT_GAME_WORKFLOW_ID?.trim() || "sveltekit-game-goal-showcase";
var SVELTEKIT_GAME_WORKFLOW_NAME = process.env.SEED_SVELTEKIT_GAME_WORKFLOW_NAME?.trim() || "Impressive SvelteKit Game (Goal Loop)";
var SVELTEKIT_GAME_WORKFLOW_DESCRIPTION = process.env.SEED_SVELTEKIT_GAME_WORKFLOW_DESCRIPTION?.trim() || "Goal-driven workflow: a CLI agent (default codex-cli) iteratively builds a polished, fully-playable SvelteKit game (default: Tetris) as a static site, until it installs, builds, and is verifiably playable; then captures a walkthrough and serves a live static preview. Exercises goal mode (goalSpec) end-to-end.";
var SVELTEKIT_GAME_APP_DIR = "/sandbox/sveltekit-game";
var SVELTEKIT_GAME_BUILD_DIR = "/sandbox/sveltekit-game/build";
var SVELTEKIT_GAME_SITE_DIR = "/sandbox/sveltekit-game-site";
var SVELTEKIT_GAME_DEFAULT_RUNTIME = parseCliRuntime(
  process.env.SEED_SVELTEKIT_GAME_DEFAULT_RUNTIME?.trim() || "codex-cli"
);
var SVELTEKIT_GAME_BASE_URL = "http://127.0.0.1:0";
var SVELTEKIT_GAME_OUTPUT_SANDBOX_NAME = '${ .workspace_profile.sandboxName // "" }';
var SVELTEKIT_GAME_OUTPUT_WORKSPACE_REF = "${ .workspace_profile.workspaceRef }";
var SVELTEKIT_GAME_DEFAULT_DESCRIPTION = "a polished, juicy Tetris game with all 7 tetrominoes, a hold slot and next-piece queue, increasing levels, line-clear scoring, and a neon arcade aesthetic";
var SVELTEKIT_GAME_DEFAULT_MAX_ITERATIONS = 30;
var SVELTEKIT_GAME_GOAL_OBJECTIVE = [
  '${ "Deliver a complete, genuinely playable SvelteKit browser game (Svelte 5 runes + TypeScript) in ',
  SVELTEKIT_GAME_APP_DIR,
  ', built to a SELF-CONTAINED STATIC SITE, implementing: " + (.trigger.gameDescription // "',
  SVELTEKIT_GAME_DEFAULT_DESCRIPTION,
  '") + ". Configure @sveltejs/adapter-static and prerender the page so npm run build emits a fully static, client-side-playable ',
  SVELTEKIT_GAME_BUILD_DIR,
  "/index.html (plus assets) that needs NO server to run. DONE means ALL of: ",
  "(1) npm install succeeds; ",
  "(2) npm run build passes with no errors and produces ",
  SVELTEKIT_GAME_BUILD_DIR,
  "/index.html; ",
  "(3) the game is actually playable end-to-end from the STATIC build \u2014 the board renders, the on-screen control buttons AND the keyboard both change game state, the score updates during play, and game-over followed by restart works; ",
  "(4) there are no console, build, or type errors; ",
  "(5) the PRERENDERED ",
  SVELTEKIT_GAME_BUILD_DIR,
  '/index.html already contains the data-test hooks WITHOUT running any JS \u2014 i.e. the start screen / shell (game-root, start, score, board) and the on-screen control buttons (move-left, move-right, rotate, drop) are server-rendered into the static HTML, not injected only by client-side JS. Verify with: grep -o \\"data-test=...\\" ',
  SVELTEKIT_GAME_BUILD_DIR,
  "/index.html shows game-root, start, score, board, move-left, move-right, rotate AND drop. ",
  'Keep iterating until every criterion is verified by actually building and exercising the static output; do not declare the goal complete early." }'
].join("");
var SVELTEKIT_GAME_BUILD_PROMPT = [
  '${ "Build a polished, impressive SvelteKit game in ',
  SVELTEKIT_GAME_APP_DIR,
  ', shipped as a STATIC site. Game: " + (.trigger.gameDescription // "',
  SVELTEKIT_GAME_DEFAULT_DESCRIPTION,
  '") + ". ',
  "Scaffold a REAL SvelteKit project (svelte + vite + @sveltejs/kit), add @sveltejs/adapter-static, and configure it for a fully static client-side build: set adapter-static (with fallback 'index.html') and mark the game page prerenderable (export const prerender = true). ",
  "Implement full game states (start screen, playing, paused, game over), a scoring system, increasing difficulty, win/lose handling, and restart. ",
  "Controls MUST work with BOTH the keyboard AND on-screen buttons so the game is playable on touch and automatable. ",
  'Expose these STABLE test hooks as data-test attributes on clickable elements: data-test=\\"game-root\\" (top-level container), data-test=\\"start\\" (start / new game), data-test=\\"score\\" (live score readout), data-test=\\"board\\" (play area), and on-screen control buttons data-test=\\"move-left\\", data-test=\\"move-right\\", data-test=\\"rotate\\", and data-test=\\"drop\\" (map each to the equivalent move for the chosen game). ',
  "CRITICAL: these hooks must be PRERENDERED into the static index.html \u2014 render the game shell, start screen, score, board and the four control buttons in normal markup (not created only by client-side JS in onMount), so `grep data-test build/index.html` shows ALL of them. Use the canvas / JS only for the dynamic piece animation; the DOM scaffold + controls must exist in the server-rendered HTML. ",
  "Verify by running npm install and npm run build, confirm ",
  SVELTEKIT_GAME_BUILD_DIR,
  "/index.html exists, and that the static build is genuinely playable (you MAY serve the build directory with a transient static file server to test, but do NOT leave any long-lived server running \u2014 the workflow serves the preview). ",
  "IMPORTANT: npm install and npm run build can each take one to two minutes \u2014 run them in the FOREGROUND and WAIT for them to finish; do NOT background-and-kill them on a timer. The 'EnvHttpProxyAgent is experimental' line is HARMLESS Node noise (NOT a proxy error or a hang) \u2014 ignore it; you may prefix commands with NODE_NO_WARNINGS=1 to silence it. ",
  'Fix every error before finishing." }'
].join("");
var AGENT_PROFILE_TEMPLATE_ID = "tpl_coding_agent";
var PLANNER_MAX_TURNS = 120;
var PLANNER_TIMEOUT_MINUTES = 45;
var EXECUTOR_MAX_TURNS = 260;
var EXECUTOR_TIMEOUT_MINUTES = 120;
var IDs = {
  trigger: "tr_1771706813719",
  profile: "pf_1771706813719",
  clone: "cl_1771706813719",
  branch: "br_1771706813719",
  plan: "pl_1771706813719",
  execute: "ex_1771706813719",
  verifyChanges: "vr_1771706813719",
  commitPushPr: "cp_1771706813719",
  cleanup: "cu_1771706813719"
};
var EDGE_IDS = [
  "e1_1771706813719",
  "e2_1771706813719",
  "e3_1771706813719",
  "e4_1771706813719",
  "e5_1771706813719",
  "e6_1771706813719",
  "e7_1771706813719",
  "e8_1771706813719"
];
var PLANNER_INSTRUCTIONS = "You are a planning agent. Inspect repository context with read-only actions and produce an execution-ready plan only. Do not modify files, do not run mutating commands, and do not claim edits were made. Return concise, ordered steps that can be executed directly.";
var EXECUTOR_INSTRUCTIONS = "You are an autonomous coding agent operating on a real git workspace. Inspect relevant files before changing code, then make concrete file edits instead of returning only a plan. When code changes are requested, run targeted validation commands and iterate until failures are addressed. Prefer direct replacement of stale legacy code when a better implementation is required. Before finishing, confirm git diff is non-empty and report changed files, validation commands, and any remaining risks.";
var OPENSHELL_FEATURE_IDS = {
  trigger: "pyfRyGXMGC4XjyAsuUqHP",
  profile: "bsvzX1JV4drJaHWrqJ0X6",
  clone: "kd2jQ1LXuPulwa6DYrYcS",
  plan: "UQTpn3KVZ_6Zv7uzA6ril",
  execute: "084qYyW7OIG9R6ro3v2kR",
  review: "0uS-4imBYrFvz81G63Lq5",
  browserProfile: "z5fbA93GEu6nWZDbtS3da",
  browserClone: "udqANW2lP7cL93Kk6qhTf",
  browserMaterialize: "mspYoB2o7FhDb1n9kXjLp",
  browserInstall: "i4yQm3GpR8sLd6Nx1eVcw",
  browserServer: "s8uRt4KdP2nVm6Xa0bQje",
  browserCapture: "c1vUy5LgT9qZn3Hr4pWms"
};
var OPENSHELL_FEATURE_EDGE_IDS = [
  "fivLJSWp--wp9jk60o3Zv",
  "D-6Bw2hYnFuiv_iFPLnTJ",
  "1scYFdFp6dscbGiMlWI7g",
  "qa4XLL54R6_eKdss58ZRF",
  "YpUGC9sdpzb2dcLzJQQ5f",
  "Br7NMXDbWg4xT1y2zQ3Cp",
  "Rk4JHzdPq9mLs2vNc8Twf",
  "Vx3QbLmRk8sNf1yHp6Dca",
  "Nq7PwXeLr2tVm5hJc9Bsd",
  "Hm5QsTnXv4cLp8rZd1Wkb",
  "Jt8LyPnQr3vHb6xMs2Cde"
];
async function resolveGithubUserId(db) {
  const configuredUserId = process.env.SEED_WORKFLOW_USER_ID?.trim() || process.env.SEED_GITHUB_USER_ID?.trim();
  const configuredEmail = process.env.SEED_WORKFLOW_USER_EMAIL?.trim() || process.env.SEED_GITHUB_USER_EMAIL?.trim();
  if (configuredUserId) {
    const identity = await db.query.userIdentities.findFirst({
      where: and(
        eq(userIdentities.userId, configuredUserId),
        eq(userIdentities.provider, "GITHUB")
      )
    });
    if (!identity) {
      throw new Error(
        `SEED_GITHUB_USER_ID (${configuredUserId}) does not map to a GITHUB identity.`
      );
    }
    return configuredUserId;
  }
  if (configuredEmail) {
    const matches = await db.select({ id: users.id }).from(users).where(eq(users.email, configuredEmail)).limit(2);
    if (matches.length === 0) {
      throw new Error(
        `SEED_GITHUB_USER_EMAIL (${configuredEmail}) does not match a user.`
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `SEED_GITHUB_USER_EMAIL (${configuredEmail}) is ambiguous. Set SEED_GITHUB_USER_ID.`
      );
    }
    const resolvedUserId = matches[0].id;
    const identity = await db.query.userIdentities.findFirst({
      where: and(
        eq(userIdentities.userId, resolvedUserId),
        eq(userIdentities.provider, "GITHUB")
      )
    });
    if (!identity) {
      throw new Error(
        `User resolved from SEED_GITHUB_USER_EMAIL (${configuredEmail}) has no GITHUB identity.`
      );
    }
    return resolvedUserId;
  }
  const githubUsers = await db.select({ userId: userIdentities.userId }).from(userIdentities).where(eq(userIdentities.provider, "GITHUB")).limit(2);
  if (githubUsers.length === 0) {
    throw new Error(
      "No GITHUB users found. Set SEED_GITHUB_USER_ID/SEED_GITHUB_USER_EMAIL or sign in with GitHub first."
    );
  }
  if (githubUsers.length > 1) {
    throw new Error(
      "Multiple GITHUB users found. Set SEED_GITHUB_USER_ID (preferred) or SEED_GITHUB_USER_EMAIL."
    );
  }
  return githubUsers[0].userId;
}
async function resolveProjectId(db, userId) {
  const configuredProjectId = process.env.SEED_WORKFLOW_PROJECT_ID?.trim();
  if (configuredProjectId) {
    const explicitProject = await db.query.projects.findFirst({
      where: eq(projects.id, configuredProjectId)
    });
    if (!explicitProject) {
      throw new Error(
        `SEED_WORKFLOW_PROJECT_ID (${configuredProjectId}) does not match a project.`
      );
    }
    const membership2 = await db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.projectId, configuredProjectId),
        eq(projectMembers.userId, userId)
      )
    });
    if (explicitProject.ownerId !== userId && !membership2) {
      throw new Error(
        `SEED_WORKFLOW_PROJECT_ID (${configuredProjectId}) is not owned by or shared with user ${userId}.`
      );
    }
    return explicitProject.id;
  }
  const canonicalExternalId = `project-${userId}`;
  const canonicalProject = await db.query.projects.findFirst({
    where: eq(projects.externalId, canonicalExternalId)
  });
  if (canonicalProject) return canonicalProject.id;
  const ownedProject = await db.query.projects.findFirst({
    where: eq(projects.ownerId, userId),
    orderBy: [desc(projects.updatedAt)]
  });
  if (ownedProject) return ownedProject.id;
  const membership = await db.query.projectMembers.findFirst({
    where: eq(projectMembers.userId, userId),
    orderBy: [desc(projectMembers.updatedAt)]
  });
  if (membership) return membership.projectId;
  throw new Error(
    `No project found for user ${userId}. Seed user/project first via db-seed.`
  );
}
async function resolveAgentProfileVersion(db) {
  try {
    const preferred = await db.query.agentProfileTemplateVersions.findFirst({
      where: and(
        eq(agentProfileTemplateVersions.templateId, AGENT_PROFILE_TEMPLATE_ID),
        eq(agentProfileTemplateVersions.isDefault, true)
      ),
      orderBy: [desc(agentProfileTemplateVersions.version)]
    });
    if (preferred) return preferred.version;
    const latest = await db.query.agentProfileTemplateVersions.findFirst({
      where: eq(
        agentProfileTemplateVersions.templateId,
        AGENT_PROFILE_TEMPLATE_ID
      ),
      orderBy: [desc(agentProfileTemplateVersions.version)]
    });
    if (!latest) {
      throw new Error(
        `No versions found for agent profile template ${AGENT_PROFILE_TEMPLATE_ID}.`
      );
    }
    return latest.version;
  } catch (error) {
    const code = error.cause?.code;
    if (code === "42P01") {
      console.warn(
        `[seed-workflows] Agent profile template tables are missing; using ${AGENT_PROFILE_TEMPLATE_ID} version 1.`
      );
      return 1;
    }
    throw error;
  }
}
async function resolveLatestGithubConnection(db, userId) {
  const connections = await db.select({
    id: appConnections.id,
    externalId: appConnections.externalId,
    pieceName: appConnections.pieceName
  }).from(appConnections).where(eq(appConnections.ownerId, userId)).orderBy(desc(appConnections.updatedAt), desc(appConnections.createdAt)).limit(25);
  const connection2 = connections.find(
    (row) => row.pieceName.toLowerCase().includes("github")
  );
  if (!connection2) {
    return void 0;
  }
  return {
    connectionId: connection2.id,
    connectionExternalId: connection2.externalId
  };
}
function buildOpenShellFeatureReviewCommand() {
  return `cat <<'__WF_OPEN_SHELL_REVIEW__'
OpenShell LangGraph execution review
===================================
Sandbox name:
{{@${OPENSHELL_FEATURE_IDS.execute}:OpenShell LangGraph Execute.sandboxName}}

Provider:
{{@${OPENSHELL_FEATURE_IDS.execute}:OpenShell LangGraph Execute.provider}}

File changes:
{{@${OPENSHELL_FEATURE_IDS.execute}:OpenShell LangGraph Execute.fileChanges}}

Change summary:
{{@${OPENSHELL_FEATURE_IDS.execute}:OpenShell LangGraph Execute.changeSummary}}

Snapshot refs:
{{@${OPENSHELL_FEATURE_IDS.execute}:OpenShell LangGraph Execute.snapshotRefs}}

Patch:
{{@${OPENSHELL_FEATURE_IDS.execute}:OpenShell LangGraph Execute.patch}}
__WF_OPEN_SHELL_REVIEW__`;
}
function buildOpenShellValidationInstallCommand() {
  return "(while true; do echo install-heartbeat; sleep 25; done &) ; cd basics/basics-final && attempt=1; until [ $attempt -gt 3 ]; do if [ -f pnpm-lock.yaml ] || [ -f ../../pnpm-lock.yaml ]; then corepack enable pnpm 2>/dev/null; pnpm install --no-frozen-lockfile --prefer-offline; elif [ -f package-lock.json ]; then npm ci --no-audit --no-fund --loglevel=warn --prefer-offline; else npm install --no-audit --no-fund --loglevel=warn --fetch-retries=5 --fetch-retry-factor=2 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=120000 --prefer-offline; fi && exit 0; if [ $attempt -eq 3 ]; then exit 1; fi; echo retrying-install-attempt-$attempt; attempt=$((attempt + 1)); sleep 5; done";
}
function buildOpenShellValidationDevServerCommand() {
  return 'cd basics/basics-final && mkdir -p .wf-preview && rm -f .wf-preview/dev-server.log .wf-preview/dev-server.pid && setsid sh -c "npm run dev -- --hostname 0.0.0.0 --port 3000 > .wf-preview/dev-server.log 2>&1 < /dev/null" >/dev/null 2>&1 & pid=$!; echo $pid > .wf-preview/dev-server.pid; echo waiting-for-port-3000; for i in $(seq 1 90); do if curl -sf -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; then echo server-ready-on-port-3000; exit 0; fi; if ! kill -0 $pid 2>/dev/null; then echo server-exited-early; cat .wf-preview/dev-server.log; exit 1; fi; sleep 2; done; echo server-timeout-waiting-for-port; tail -30 .wf-preview/dev-server.log; exit 1';
}
function buildOpenShellValidationCaptureSteps() {
  return JSON.stringify(
    [
      {
        id: "dashboard-home",
        label: "Dashboard Home",
        path: "/",
        waitForSelector: "body",
        delayMs: 3e3
      }
    ],
    null,
    2
  );
}
function buildOpenShellLangGraphFeatureDeliveryNodes(input) {
  const connectionId = input?.connectionId;
  const connectionExternalId = input?.connectionExternalId;
  const agentProfileVersion = input?.agentProfileVersion ?? 2;
  const workspaceRef = `{{@${OPENSHELL_FEATURE_IDS.profile}:Workspace Profile.workspaceRef}}`;
  const clonePath = `{{@${OPENSHELL_FEATURE_IDS.clone}:Workspace Clone.clonePath}}`;
  const executionId = `{{@${OPENSHELL_FEATURE_IDS.profile}:Workspace Profile.executionId}}`;
  const browserWorkspaceRef = `{{@${OPENSHELL_FEATURE_IDS.browserProfile}:Browser Validation Workspace.workspaceRef}}`;
  const authValue = connectionExternalId ? `{{connections['${connectionExternalId}']}}` : "{{connections['github']}}";
  const agentProfileRef = JSON.stringify({
    id: AGENT_PROFILE_TEMPLATE_ID,
    slug: "coding-agent",
    name: "Coding Agent",
    version: agentProfileVersion
  });
  const agentConfig = JSON.stringify({
    name: "Coding Agent",
    instructions: EXECUTOR_INSTRUCTIONS,
    modelSpec: "gpt-5.5",
    maxTurns: 260,
    timeoutMinutes: 120,
    tools: ["glob", "grep", "read", "edit", "write", "bash"],
    requiredCapabilities: ["git", "bash"],
    preferredExecutionProfile: "node-npm",
    preferredSandboxProfile: "node-npm",
    workspaceBackend: "openshell"
  });
  return normalizeWorkflowNodes([
    {
      id: OPENSHELL_FEATURE_IDS.trigger,
      type: "trigger",
      position: { x: 12, y: 12 },
      data: {
        type: "trigger",
        label: "Manual Trigger",
        description: "Run this workflow and paste the feature request into the Run Workflow form.",
        config: {
          triggerType: "Manual",
          inputSchema: JSON.stringify([
            {
              name: "feature_request",
              type: "TEXT",
              required: true,
              description: "Describe the feature, bug fix, or implementation task for this run."
            }
          ])
        },
        status: "idle"
      }
    },
    {
      id: OPENSHELL_FEATURE_IDS.profile,
      type: "action",
      position: { x: 12, y: 224 },
      data: {
        type: "action",
        label: "Workspace Profile",
        description: "Create an execution-scoped workspace session.",
        config: {
          name: "openshell-langgraph-feature-delivery",
          actionType: "workspace/profile",
          enabledTools: JSON.stringify([
            "read",
            "write",
            "edit",
            "list",
            "bash"
          ]),
          commandTimeoutMs: "120000",
          requireReadBeforeWrite: "true"
        },
        status: "idle"
      }
    },
    {
      id: OPENSHELL_FEATURE_IDS.clone,
      type: "action",
      position: { x: 12, y: 436 },
      data: {
        type: "action",
        label: "Workspace Clone",
        description: "Clone the target repository into the workspace.",
        config: {
          auth: authValue,
          targetDir: "next-learn",
          actionType: "workspace/clone",
          workspaceRef,
          repositoryOwner: "PittampalliOrg",
          repositoryRepo: "next-learn",
          repositoryBranch: "main",
          ...connectionId ? { integrationId: connectionId } : {}
        },
        status: "idle"
      }
    },
    {
      id: OPENSHELL_FEATURE_IDS.plan,
      type: "action",
      position: { x: 12, y: 648 },
      data: {
        type: "action",
        label: "OpenShell LangGraph Plan",
        description: "Inspect the repository inside OpenShell, build a concrete implementation plan, and wait for approval.",
        config: {
          cwd: clonePath,
          mode: "plan_mode",
          model: "gpt-5.5",
          tools: JSON.stringify([
            "glob",
            "grep",
            "read",
            "edit",
            "write",
            "bash"
          ]),
          engine: "langgraph",
          prompt: "You are planning a repository feature delivery task for this specific codebase.\n\nUser feature request:\n{{@trigger:Manual.feature_request}}\n\nPlanning requirements:\n- Inspect the repository first and stay read-only during this step.\n- Build a concrete implementation plan for this exact repository, not a generic solution.\n- Prefer the smallest cohesive change set that satisfies the request.\n- Identify the likely files/modules to touch, tests to add or update, validation commands to run, and any important risks or assumptions.\n- If the request is underspecified, make the minimum necessary assumptions and state them explicitly.\n\nReturn only the final implementation plan for approval.",
          profile: "feature-delivery",
          maxTurns: "24",
          actionType: "durable/run",
          toolPolicy: "all",
          agentConfig,
          shellPolicy: "workspace-safe",
          writePolicy: "workspace-only",
          workspaceRef,
          repositoryUrl: "https://github.com/PittampalliOrg/next-learn.git",
          stopCondition: "An implementation plan exists for the user request and is ready for review and approval.",
          expectedOutput: "An approved implementation plan with impacted files, validation steps, assumptions, and risks.",
          repositoryRepo: "next-learn",
          timeoutMinutes: "60",
          verifyCommands: "npm run build",
          agentProfileRef,
          repositoryOwner: "PittampalliOrg",
          sandboxRepoPath: "/sandbox/repo",
          planningThreadId: `lg:plan:${executionId}`,
          repositoryBranch: "main",
          workspaceBackend: "openshell",
          executionThreadId: `lg:exec:${executionId}`,
          instructionsOverlay: `${EXECUTOR_INSTRUCTIONS}

Additional workflow instructions:
${EXECUTOR_INSTRUCTIONS}

Additional workflow instructions:
${EXECUTOR_INSTRUCTIONS}`,
          executeAfterApproval: "false",
          requiredCapabilities: JSON.stringify(["git", "bash"]),
          agentProfileTemplateId: AGENT_PROFILE_TEMPLATE_ID,
          approvalTimeoutMinutes: "1440",
          preferredSandboxProfile: "node-npm",
          preferredExecutionProfile: "node-npm",
          agentProfileTemplateVersion: String(agentProfileVersion)
        },
        status: "idle"
      }
    },
    {
      id: OPENSHELL_FEATURE_IDS.execute,
      type: "action",
      position: { x: 12, y: 860 },
      data: {
        type: "action",
        label: "OpenShell LangGraph Execute",
        description: "Implement the approved plan inside OpenShell, validate the changes, and summarize the result.",
        config: {
          cwd: clonePath,
          mode: "execute_direct",
          model: "gpt-5.5",
          tools: JSON.stringify([
            "glob",
            "grep",
            "read",
            "edit",
            "write",
            "bash"
          ]),
          engine: "langgraph",
          prompt: "Implement the approved feature plan for this repository.\n\nOriginal user feature request:\n{{@trigger:Manual.feature_request}}\n\nExecution requirements:\n- Follow the approved plan artifact as the primary source of truth.\n- Match existing repository patterns and architecture.\n- Keep the change set cohesive and avoid unrelated edits.\n- Add or update tests when behavior changes.\n- Run the provided validation commands and any targeted checks needed for the changed code.\n- If the approved plan needs a small adaptation based on repository realities, make the smallest justified adjustment and explain it clearly in the final summary.\n\nReturn a concise engineering summary that includes changed files, verification results, and residual risks.",
          profile: "implement",
          maxTurns: "80",
          actionType: "durable/run",
          toolPolicy: "all",
          agentConfig,
          artifactRef: `{{@${OPENSHELL_FEATURE_IDS.plan}:OpenShell LangGraph Plan.artifactRef}}`,
          shellPolicy: "workspace-safe",
          writePolicy: "workspace-only",
          workspaceRef,
          repositoryUrl: "https://github.com/PittampalliOrg/next-learn.git",
          stopCondition: "The requested feature is implemented, relevant verification has been run, and the final response includes changed files, verification results, and residual risks.",
          expectedOutput: "A concise engineering summary, changed-file list, verification results, and residual risks.",
          repositoryRepo: "next-learn",
          timeoutMinutes: "60",
          verifyCommands: "npm run build",
          agentProfileRef,
          repositoryOwner: "PittampalliOrg",
          sandboxRepoPath: "/sandbox/repo",
          planningThreadId: `lg:plan:${executionId}`,
          repositoryBranch: "main",
          workspaceBackend: "openshell",
          executionThreadId: `lg:exec:${executionId}`,
          instructionsOverlay: `${EXECUTOR_INSTRUCTIONS}

Additional workflow instructions:
${EXECUTOR_INSTRUCTIONS}

Additional workflow instructions:
${EXECUTOR_INSTRUCTIONS}`,
          requiredCapabilities: JSON.stringify(["git", "bash"]),
          agentProfileTemplateId: AGENT_PROFILE_TEMPLATE_ID,
          preferredSandboxProfile: "node-npm",
          preferredExecutionProfile: "node-npm",
          agentProfileTemplateVersion: String(agentProfileVersion)
        },
        status: "idle"
      }
    },
    {
      id: OPENSHELL_FEATURE_IDS.review,
      type: "action",
      position: { x: 12, y: 1072 },
      data: {
        type: "action",
        label: "Review Workspace Changes",
        description: "Show persisted OpenShell file change context from the execute step output.",
        config: {
          command: buildOpenShellFeatureReviewCommand(),
          timeoutMs: "120000",
          actionType: "workspace/command",
          workspaceRef,
          continueOnError: "true"
        },
        status: "idle"
      }
    },
    {
      id: OPENSHELL_FEATURE_IDS.browserProfile,
      type: "action",
      position: { x: 12, y: 1284 },
      data: {
        type: "action",
        label: "Browser Validation Workspace",
        description: "Provision an OpenShell browser validation workspace for dev-server validation and screenshots.",
        config: {
          name: "browser-validation",
          actionType: "browser/profile",
          commandTimeoutMs: "360000",
          sandboxTemplate: "openshell-browser"
        },
        status: "idle"
      }
    },
    {
      id: OPENSHELL_FEATURE_IDS.browserClone,
      type: "action",
      position: { x: 12, y: 1496 },
      data: {
        type: "action",
        label: "Browser Validation Clone",
        description: "Clone the target repository into the browser validation workspace.",
        config: {
          targetDir: "next-learn",
          actionType: "browser/clone",
          workspaceRef: browserWorkspaceRef,
          repositoryUrl: OPENSHELL_LANGGRAPH_BROWSER_VALIDATION_REPOSITORY_URL,
          repositoryOwner: "PittampalliOrg",
          repositoryRepo: "next-learn",
          repositoryBranch: "main"
        },
        status: "idle"
      }
    },
    {
      id: OPENSHELL_FEATURE_IDS.browserMaterialize,
      type: "action",
      position: { x: 12, y: 1708 },
      data: {
        type: "action",
        label: "Browser Materialize Changes",
        description: "Restore the latest execute-step code changes into the browser validation clone.",
        config: {
          actionType: "browser/materialize-change-artifact",
          workspaceRef: browserWorkspaceRef,
          preferredOperation: "agent-execute"
        },
        status: "idle"
      }
    },
    {
      id: OPENSHELL_FEATURE_IDS.browserInstall,
      type: "action",
      position: { x: 12, y: 1920 },
      data: {
        type: "action",
        label: "Browser Install Dependencies",
        description: "Install app dependencies inside the validation clone.",
        config: {
          actionType: "browser/command",
          workspaceRef: browserWorkspaceRef,
          command: buildOpenShellValidationInstallCommand(),
          timeoutMs: "3600000"
        },
        status: "idle"
      }
    },
    {
      id: OPENSHELL_FEATURE_IDS.browserServer,
      type: "action",
      position: { x: 12, y: 2132 },
      data: {
        type: "action",
        label: "Browser Start Dev Server",
        description: "Start the Next.js dev server and wait until the app responds on port 3000.",
        config: {
          actionType: "browser/command",
          workspaceRef: browserWorkspaceRef,
          command: buildOpenShellValidationDevServerCommand(),
          timeoutMs: "900000"
        },
        status: "idle"
      }
    },
    {
      id: OPENSHELL_FEATURE_IDS.browserCapture,
      type: "action",
      position: { x: 12, y: 2344 },
      data: {
        type: "action",
        label: "Browser Capture Flow",
        description: "Navigate the dashboard UI and persist screenshots as durable browser artifacts.",
        config: {
          actionType: "browser/capture-flow",
          workspaceRef: browserWorkspaceRef,
          baseUrl: "http://127.0.0.1:3000",
          steps: buildOpenShellValidationCaptureSteps(),
          timeoutMs: "180000"
        },
        status: "idle"
      }
    }
  ]);
}
function buildOpenShellLangGraphFeatureDeliveryEdges() {
  return [
    {
      id: OPENSHELL_FEATURE_EDGE_IDS[0],
      type: "animated",
      source: OPENSHELL_FEATURE_IDS.trigger,
      target: OPENSHELL_FEATURE_IDS.profile,
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: OPENSHELL_FEATURE_EDGE_IDS[1],
      type: "animated",
      source: OPENSHELL_FEATURE_IDS.profile,
      target: OPENSHELL_FEATURE_IDS.clone,
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: OPENSHELL_FEATURE_EDGE_IDS[2],
      type: "animated",
      source: OPENSHELL_FEATURE_IDS.clone,
      target: OPENSHELL_FEATURE_IDS.plan,
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: OPENSHELL_FEATURE_EDGE_IDS[3],
      type: "animated",
      source: OPENSHELL_FEATURE_IDS.plan,
      target: OPENSHELL_FEATURE_IDS.execute,
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: OPENSHELL_FEATURE_EDGE_IDS[4],
      type: "animated",
      source: OPENSHELL_FEATURE_IDS.execute,
      target: OPENSHELL_FEATURE_IDS.review
    },
    {
      id: OPENSHELL_FEATURE_EDGE_IDS[5],
      type: "animated",
      source: OPENSHELL_FEATURE_IDS.review,
      target: OPENSHELL_FEATURE_IDS.browserProfile
    },
    {
      id: OPENSHELL_FEATURE_EDGE_IDS[6],
      type: "animated",
      source: OPENSHELL_FEATURE_IDS.browserProfile,
      target: OPENSHELL_FEATURE_IDS.browserClone
    },
    {
      id: OPENSHELL_FEATURE_EDGE_IDS[7],
      type: "animated",
      source: OPENSHELL_FEATURE_IDS.browserClone,
      target: OPENSHELL_FEATURE_IDS.browserMaterialize
    },
    {
      id: OPENSHELL_FEATURE_EDGE_IDS[8],
      type: "animated",
      source: OPENSHELL_FEATURE_IDS.browserMaterialize,
      target: OPENSHELL_FEATURE_IDS.browserInstall
    },
    {
      id: OPENSHELL_FEATURE_EDGE_IDS[9],
      type: "animated",
      source: OPENSHELL_FEATURE_IDS.browserInstall,
      target: OPENSHELL_FEATURE_IDS.browserServer
    },
    {
      id: OPENSHELL_FEATURE_EDGE_IDS[10],
      type: "animated",
      source: OPENSHELL_FEATURE_IDS.browserServer,
      target: OPENSHELL_FEATURE_IDS.browserCapture,
      sourceHandle: null,
      targetHandle: null
    }
  ];
}
function buildNodes2(profileVersion) {
  const workspaceRef = `{{@${IDs.profile}:Workspace Profile.workspaceRef}}`;
  const clonePath = `{{@${IDs.clone}:Workspace Clone.clonePath}}`;
  const executionId = `{{@${IDs.profile}:Workspace Profile.executionId}}`;
  return normalizeWorkflowNodes([
    {
      id: IDs.trigger,
      type: "trigger",
      position: { x: -740, y: 0 },
      data: {
        label: "Manual Trigger",
        description: "",
        type: "trigger",
        config: { triggerType: "Manual" },
        status: "idle"
      }
    },
    {
      id: IDs.profile,
      type: "action",
      position: { x: -500, y: 0 },
      data: {
        label: "Workspace Profile",
        description: "Create execution-scoped workspace session",
        type: "action",
        config: {
          name: "opencode-planexec-profile",
          actionType: "workspace/profile",
          enabledTools: '["read","write","edit","list","bash"]',
          commandTimeoutMs: "120000",
          requireReadBeforeWrite: "true"
        },
        status: "idle"
      }
    },
    {
      id: IDs.clone,
      type: "action",
      position: { x: -240, y: 0 },
      data: {
        label: "Workspace Clone",
        description: "Clone target repository",
        type: "action",
        config: {
          actionType: "workspace/clone",
          workspaceRef,
          repositoryUrl: "http://gitea-http.gitea.svc.cluster.local:3000/giteaadmin/workflow-smoke.git",
          repositoryRepo: "workflow-smoke",
          repositoryOwner: "giteaadmin",
          repositoryBranch: "main",
          repositoryUsername: "giteaadmin",
          repositoryToken: "developer"
        },
        status: "idle"
      }
    },
    {
      id: IDs.branch,
      type: "action",
      position: { x: 20, y: 0 },
      data: {
        label: "Create Branch",
        description: "Create branch for this run",
        type: "action",
        config: {
          command: `set -euo pipefail; BR=opencode-planexec-${executionId}; git checkout -b "$BR"; echo BRANCH=$BR; git status --short`,
          timeoutMs: "120000",
          actionType: "workspace/command",
          workspaceRef
        },
        status: "idle"
      }
    },
    {
      id: IDs.plan,
      type: "action",
      position: { x: 280, y: 0 },
      data: {
        label: "Plan Changes",
        description: "Generate plan only (no execution)",
        type: "action",
        config: {
          actionType: "durable/run",
          mode: "plan_mode",
          model: "openai/gpt-5.5",
          prompt: "Analyze this minimal workflow-smoke repository and produce an execution-ready plan for a small but real multi-file repository improvement.\n\nCurrent repository context:\n- The repository is intentionally minimal.\n- It currently contains a README and is used for workflow smoke tests.\n\nRequired deliverables:\n1) scripts/generate-report.sh\n   - bash script that writes docs/report.md summarizing the repository purpose and current branch.\n2) scripts/verify-repo.sh\n   - bash script that checks required files exist and that docs/report.md contains the expected heading.\n3) docs/report.md\n   - generated project report with at least:\n     - title\n     - repository purpose\n     - workflow smoke note\n4) docs/usage.md\n   - short usage instructions for the two scripts.\n\nValidation expectation for execute step:\n- bash -n scripts/generate-report.sh scripts/verify-repo.sh\n- bash scripts/generate-report.sh\n- bash scripts/verify-repo.sh\n\nReturn a concise, ordered plan in <proposed_plan> format.",
          maxTurns: String(PLANNER_MAX_TURNS),
          timeoutMinutes: String(PLANNER_TIMEOUT_MINUTES),
          contextPolicyPreset: "conservative",
          autoApprovePlan: "true",
          autoApproveReason: "Auto-approved for workflow smoke execution",
          autoApproveActor: "system:workflow-smoke",
          workspaceRef,
          cwd: clonePath,
          agentConfig: {
            name: "Planning Agent",
            tools: ["glob", "grep", "read"],
            modelSpec: "openai/gpt-5.5",
            maxTurns: PLANNER_MAX_TURNS,
            instructions: PLANNER_INSTRUCTIONS,
            timeoutMinutes: PLANNER_TIMEOUT_MINUTES
          },
          agentProfileRef: {
            id: AGENT_PROFILE_TEMPLATE_ID,
            name: "Planning Agent",
            slug: "coding-agent",
            version: profileVersion
          },
          agentProfileTemplateId: AGENT_PROFILE_TEMPLATE_ID,
          agentProfileTemplateVersion: profileVersion
        },
        status: "idle"
      }
    },
    {
      id: IDs.execute,
      type: "action",
      position: { x: 540, y: 0 },
      data: {
        label: "Execute Plan",
        description: "Execute plan with concrete file edits",
        type: "action",
        config: {
          actionType: "durable/run",
          mode: "execute_direct",
          model: "openai/gpt-5.5",
          prompt: "Execute the approved plan artifact and implement the repository improvement in this minimal workflow-smoke repo.\n\nYou must create or update exactly these repository files:\n- scripts/generate-report.sh\n- scripts/verify-repo.sh\n- docs/report.md\n- docs/usage.md\n\nHard requirements:\n- Use mutating file tools to create or update those files. Reading files or creating empty directories is not sufficient.\n- scripts/generate-report.sh must write docs/report.md with a '# Repository Report' heading, repository purpose, workflow smoke note, and current branch.\n- scripts/verify-repo.sh must fail if any required file is missing or if docs/report.md does not start with '# Repository Report'.\n- docs/usage.md must explain how to run both scripts.\n- Run and report these commands before finishing:\n  - bash -n scripts/generate-report.sh scripts/verify-repo.sh\n  - bash scripts/generate-report.sh\n  - bash scripts/verify-repo.sh\n- Do not stop after planning, inspection, or directory creation. Finish only after the four required files exist and validation commands pass.",
          maxTurns: String(EXECUTOR_MAX_TURNS),
          timeoutMinutes: String(EXECUTOR_TIMEOUT_MINUTES),
          contextPolicyPreset: "balanced",
          workspaceRef,
          cwd: clonePath,
          artifactRef: `{{@${IDs.plan}:Plan Changes.artifactRef}}`,
          stopCondition: "Stop only when scripts/generate-report.sh, scripts/verify-repo.sh, docs/report.md, and docs/usage.md have been created or updated with file-writing tools, and the validation commands pass.",
          cleanupWorkspace: "false",
          requireFileChanges: "true",
          agentConfig: {
            name: "Coding Agent",
            tools: ["glob", "grep", "read", "edit", "write", "bash"],
            modelSpec: "openai/gpt-5.5",
            maxTurns: EXECUTOR_MAX_TURNS,
            instructions: EXECUTOR_INSTRUCTIONS,
            timeoutMinutes: EXECUTOR_TIMEOUT_MINUTES
          },
          agentProfileRef: {
            id: AGENT_PROFILE_TEMPLATE_ID,
            name: "Coding Agent",
            slug: "coding-agent",
            version: profileVersion
          },
          agentProfileTemplateId: AGENT_PROFILE_TEMPLATE_ID,
          agentProfileTemplateVersion: profileVersion
        },
        status: "idle"
      }
    },
    {
      id: IDs.verifyChanges,
      type: "action",
      position: { x: 800, y: 0 },
      data: {
        label: "Verify Multi-file Changes",
        description: "Ensure complex task produced required file edits",
        type: "action",
        config: {
          command: `set -euo pipefail
REQUIRED_FILES="scripts/generate-report.sh scripts/verify-repo.sh docs/report.md docs/usage.md"
for f in $REQUIRED_FILES; do
	if [ ! -f "$f" ]; then
		echo "Missing required file: $f"
		exit 2
	fi
done
CHANGED=$(git status --porcelain -- scripts/generate-report.sh scripts/verify-repo.sh docs/report.md docs/usage.md | awk '{print $2}' | sort -u)
echo "--- changed required files ---"
printf '%s
' "$CHANGED"
COUNT=$(printf '%s
' "$CHANGED" | sed '/^$/d' | wc -l | tr -d ' ')
echo "CHANGED_COUNT=$COUNT"
if [ "$COUNT" -lt 4 ]; then
	echo "Expected changes across all 4 required files."
	exit 2
fi
bash -n scripts/generate-report.sh scripts/verify-repo.sh
bash scripts/generate-report.sh
bash scripts/verify-repo.sh
FORBIDDEN=$(git status --porcelain | awk '{print $2}' | grep -E '(^|/)(__pycache__/|.*\\.pyc$|.*\\.pyo$)' || true)
if [ -n "$FORBIDDEN" ]; then
	echo "Generated Python cache files detected (must not be committed):"
	echo "$FORBIDDEN"
	exit 2
fi`,
          timeoutMs: "120000",
          actionType: "workspace/command",
          workspaceRef
        },
        status: "idle"
      }
    },
    {
      id: IDs.commitPushPr,
      type: "action",
      position: { x: 1060, y: 0 },
      data: {
        label: "Commit Push PR",
        description: "Commit changes, push branch, create PR to main",
        type: "action",
        config: {
          command: `set -euo pipefail
BR=opencode-planexec-{{@pf_1771706813719:Workspace Profile.executionId}}

# Clean common Python cache artifacts before staging.
find . -type d -name "__pycache__" -prune -exec rm -rf {} +
find . -type f \\( -name "*.pyc" -o -name "*.pyo" \\) -delete

git add -A
BAD=$(git diff --cached --name-only | grep -E '(^|/)(__pycache__/|.*\\.pyc$|.*\\.pyo$)' || true)
if [ -n "$BAD" ]; then
	echo "Refusing to commit generated Python cache artifacts:"
	echo "$BAD"
	exit 2
fi
if git diff --cached --quiet; then
	echo "No staged changes after execute step"
	exit 2
fi

git commit -m "feat: add workflow smoke support files"
git remote set-url origin http://giteaadmin:developer@gitea-http.gitea.svc.cluster.local:3000/giteaadmin/workflow-smoke.git
git push -u origin "$BR"

PR_PAYLOAD=$(jq -nc 	--arg title "Opencode workflow: workflow-smoke support files ({{@pf_1771706813719:Workspace Profile.executionId}})" 	--arg head "$BR" 	--arg base "main" 	--arg body "Automated plan+execute workflow implementing workflow-smoke support files." 	'{title:$title,head:$head,base:$base,body:$body}')
PR=$(curl -sS -u giteaadmin:developer 	-H "Content-Type: application/json" 	-X POST 	http://gitea-http.gitea.svc.cluster.local:3000/api/v1/repos/giteaadmin/workflow-smoke/pulls 	-d "$PR_PAYLOAD")
echo "$PR" | jq -r '["PR_NUMBER="+(.number|tostring),"PR_URL="+(.html_url//""),"PR_STATE="+(.state//"")] | .[]'
echo BRANCH=$BR
echo COMMIT=$(git rev-parse HEAD)
echo REMOTE=$(git remote get-url origin)`,
          timeoutMs: "180000",
          actionType: "workspace/command",
          workspaceRef
        },
        status: "idle"
      }
    },
    {
      id: IDs.cleanup,
      type: "action",
      position: { x: 1320, y: 0 },
      data: {
        label: "Workspace Cleanup",
        description: "Cleanup workspace",
        type: "action",
        config: {
          actionType: "workspace/cleanup",
          workspaceRef
        },
        status: "idle"
      }
    }
  ]);
}
function buildEdges2() {
  return [
    {
      id: EDGE_IDS[0],
      type: "animated",
      source: IDs.trigger,
      target: IDs.profile,
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: EDGE_IDS[1],
      type: "animated",
      source: IDs.profile,
      target: IDs.clone,
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: EDGE_IDS[2],
      type: "animated",
      source: IDs.clone,
      target: IDs.branch,
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: EDGE_IDS[3],
      type: "animated",
      source: IDs.branch,
      target: IDs.plan,
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: EDGE_IDS[4],
      type: "animated",
      source: IDs.plan,
      target: IDs.execute,
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: EDGE_IDS[5],
      type: "animated",
      source: IDs.execute,
      target: IDs.verifyChanges,
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: EDGE_IDS[6],
      type: "animated",
      source: IDs.verifyChanges,
      target: IDs.commitPushPr,
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: EDGE_IDS[7],
      type: "animated",
      source: IDs.commitPushPr,
      target: IDs.cleanup,
      sourceHandle: null,
      targetHandle: null
    }
  ];
}
function buildGithubSandboxCloneProofNodes(input) {
  const workspaceRef = "{{@pf_github_sandbox_clone:Workspace Profile.workspaceRef}}";
  const clonePath = "{{@cl_github_sandbox_clone:Workspace Clone.clonePath}}";
  const cloneConfig = {
    actionType: "workspace/clone",
    workspaceRef,
    repositoryOwner: "PittampalliOrg",
    repositoryRepo: "workflow-builder",
    repositoryBranch: "main"
  };
  if (input?.connectionExternalId) {
    cloneConfig.auth = `{{connections['${input.connectionExternalId}']}}`;
  }
  if (input?.connectionId) {
    cloneConfig.integrationId = input.connectionId;
  }
  const sharedPrompt = "Analyze this repository for an engineer onboarding to the project. Summarize the project purpose, the main subsystems and directories, the deployment or operations model, the key docs to read first, and the highest-priority technical or operational risks. Keep the response concise and reference concrete files or directories when relevant.";
  return normalizeWorkflowNodes([
    {
      id: "tr_github_sandbox_clone",
      type: "trigger",
      position: { x: -500, y: 0 },
      data: {
        label: "Manual Trigger",
        description: "",
        type: "trigger",
        config: { triggerType: "Manual" },
        status: "idle"
      }
    },
    {
      id: "pf_github_sandbox_clone",
      type: "action",
      position: { x: -220, y: 0 },
      data: {
        label: "Workspace Profile",
        description: "Create a Kubernetes-backed sandbox workspace.",
        type: "action",
        config: {
          actionType: "workspace/profile",
          name: "github-sandbox-clone-proof",
          enabledTools: '["read","list","bash"]',
          requireReadBeforeWrite: "true",
          commandTimeoutMs: "120000"
        },
        status: "idle"
      }
    },
    {
      id: "cl_github_sandbox_clone",
      type: "action",
      position: { x: 60, y: 0 },
      data: {
        label: "Workspace Clone",
        description: "Clone the default GitHub repository into the execution-scoped sandbox.",
        type: "action",
        config: cloneConfig,
        status: "idle"
      }
    },
    {
      id: "cm_github_sandbox_tree",
      type: "action",
      position: { x: 360, y: 0 },
      data: {
        label: "Show Repo Tree",
        description: "Print a tree-style listing of the cloned repository to prove the clone succeeded.",
        type: "action",
        config: {
          actionType: "workspace/command",
          workspaceRef,
          timeoutMs: "120000",
          command: `set -euo pipefail
TARGET='${clonePath}'
echo "CLONE_PATH=$TARGET"
if command -v tree >/dev/null 2>&1; then
	tree -a -L 3 "$TARGET"
else
	find "$TARGET" -maxdepth 3 -print | LC_ALL=C sort | sed "s#^$TARGET#.#"
fi`
        },
        status: "idle"
      }
    }
  ]);
}
function buildGithubSandboxCloneProofEdges() {
  return [
    {
      id: "e_github_sandbox_clone_1",
      type: "animated",
      source: "tr_github_sandbox_clone",
      target: "pf_github_sandbox_clone",
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: "e_github_sandbox_clone_2",
      type: "animated",
      source: "pf_github_sandbox_clone",
      target: "cl_github_sandbox_clone",
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: "e_github_sandbox_clone_3",
      type: "animated",
      source: "cl_github_sandbox_clone",
      target: "cm_github_sandbox_tree",
      sourceHandle: null,
      targetHandle: null
    }
  ];
}
function buildGithubSandboxReviewNodes(input) {
  const workspaceRef = "{{@pf_github_sandbox_review:Workspace Profile.workspaceRef}}";
  const clonePath = "{{@cl_github_sandbox_review:Workspace Clone.clonePath}}";
  const cloneConfig = {
    actionType: "workspace/clone",
    workspaceRef,
    repositoryOwner: "PittampalliOrg",
    repositoryRepo: "workflow-builder",
    repositoryBranch: "main"
  };
  const durableTools = JSON.stringify(["read", "list", "bash"]);
  if (input?.connectionExternalId) {
    cloneConfig.auth = `{{connections['${input.connectionExternalId}']}}`;
  }
  if (input?.connectionId) {
    cloneConfig.integrationId = input.connectionId;
  }
  return normalizeWorkflowNodes([
    {
      id: "tr_github_sandbox_review",
      type: "trigger",
      position: { x: -740, y: 0 },
      data: {
        label: "Manual Trigger",
        description: "",
        type: "trigger",
        config: { triggerType: "Manual" },
        status: "idle"
      }
    },
    {
      id: "pf_github_sandbox_review",
      type: "action",
      position: { x: -460, y: 0 },
      data: {
        label: "Workspace Profile",
        description: "Create a Kubernetes-backed sandbox workspace.",
        type: "action",
        config: {
          actionType: "workspace/profile",
          name: "github-sandbox-project-review",
          enabledTools: durableTools,
          requireReadBeforeWrite: "true",
          commandTimeoutMs: "120000"
        },
        status: "idle"
      }
    },
    {
      id: "cl_github_sandbox_review",
      type: "action",
      position: { x: -180, y: 0 },
      data: {
        label: "Workspace Clone",
        description: "Clone the default GitHub repository into the execution-scoped sandbox.",
        type: "action",
        config: cloneConfig,
        status: "idle"
      }
    },
    {
      id: "cm_github_sandbox_review_tree",
      type: "action",
      position: { x: 120, y: 0 },
      data: {
        label: "Show Repo Tree",
        description: "Print a tree-style listing of the cloned repository to prove the clone succeeded.",
        type: "action",
        config: {
          actionType: "workspace/command",
          workspaceRef,
          timeoutMs: "120000",
          command: `set -euo pipefail
TARGET='${clonePath}'
echo "CLONE_PATH=$TARGET"
if command -v tree >/dev/null 2>&1; then
	tree -a -L 3 "$TARGET"
else
	find "$TARGET" -maxdepth 3 -print | LC_ALL=C sort | sed "s#^$TARGET#.#"
fi`
        },
        status: "idle"
      }
    },
    {
      id: "da_github_sandbox_review",
      type: "action",
      position: { x: 460, y: 0 },
      data: {
        label: "Coding Agent Review",
        description: "Use the durable coding agent to review the repository and summarize the project.",
        type: "action",
        config: {
          actionType: "durable/run",
          mode: "execute_direct",
          agentProfileTemplateId: AGENT_PROFILE_TEMPLATE_ID,
          model: "openai/gpt-5.5",
          tools: durableTools,
          workspaceRef,
          cwd: clonePath,
          maxTurns: "20",
          timeoutMinutes: "20",
          cleanupWorkspace: "false",
          instructions: "Review the repository in read-only mode. Inspect files as needed, but do not modify anything and do not ask clarifying questions. Return a concise project summary with the most important risks first.",
          stopCondition: "A concise project review and summary has been produced with no file modifications.",
          prompt: "Review this repository and summarize the project. Cover: the project purpose, the main subsystems or directories, how it is deployed or operated, the key docs a new contributor should read, and the highest-priority technical or operational risks. Keep the answer concise and structured for an engineer onboarding to the repo."
        },
        status: "idle"
      }
    }
  ]);
}
function buildGithubSandboxReviewEdges() {
  return [
    {
      id: "e_github_sandbox_review_1",
      type: "animated",
      source: "tr_github_sandbox_review",
      target: "pf_github_sandbox_review",
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: "e_github_sandbox_review_2",
      type: "animated",
      source: "pf_github_sandbox_review",
      target: "cl_github_sandbox_review",
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: "e_github_sandbox_review_3",
      type: "animated",
      source: "cl_github_sandbox_review",
      target: "cm_github_sandbox_review_tree",
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: "e_github_sandbox_review_4",
      type: "animated",
      source: "cm_github_sandbox_review_tree",
      target: "da_github_sandbox_review",
      sourceHandle: null,
      targetHandle: null
    }
  ];
}
function buildAiCodingAgentNodes() {
  const workspaceRef = "{{@pf_ai_coding_agent:Workspace Profile.workspaceRef}}";
  const clonePath = "{{@cl_ai_coding_agent:Workspace Clone.clonePath}}";
  const sandboxRepoPath = "/sandbox/repo";
  return normalizeWorkflowNodes([
    {
      id: "tr_ai_coding_agent",
      type: "trigger",
      position: { x: -760, y: 0 },
      data: {
        label: "API Trigger",
        description: "Receives repo selection and task input from the ai/main coding-agent flow.",
        type: "trigger",
        config: {
          triggerType: "Manual",
          inputSchema: JSON.stringify([
            {
              name: "owner",
              type: "TEXT",
              required: true,
              description: "Repository owner or organization name."
            },
            {
              name: "repo",
              type: "TEXT",
              required: true,
              description: "Repository name to clone into the sandbox."
            },
            {
              name: "branch",
              type: "TEXT",
              required: false,
              description: "Repository branch to clone. Defaults to 'main' when omitted."
            },
            {
              name: "task",
              type: "TEXT",
              required: true,
              description: "Implementation task for the coding agent."
            },
            {
              name: "token",
              type: "TEXT",
              required: false,
              description: "Optional token used when the target repository requires authentication."
            }
          ])
        },
        status: "idle"
      }
    },
    {
      id: "pf_ai_coding_agent",
      type: "action",
      position: { x: -480, y: 0 },
      data: {
        label: "Workspace Profile",
        description: "Create an execution-scoped sandbox workspace for the coding session.",
        type: "action",
        config: {
          actionType: "workspace/profile",
          name: "ai-coding-agent",
          enabledTools: '["read","write","edit","list","bash"]',
          requireReadBeforeWrite: "true",
          commandTimeoutMs: "120000"
        },
        status: "idle"
      }
    },
    {
      id: "cl_ai_coding_agent",
      type: "action",
      position: { x: -180, y: 0 },
      data: {
        label: "Workspace Clone",
        description: "Clone the selected repository into the execution workspace.",
        type: "action",
        config: {
          actionType: "workspace/clone",
          workspaceRef,
          repositoryOwner: "{{trigger.owner}}",
          repositoryRepo: "{{trigger.repo}}",
          repositoryBranch: "{{trigger.branch}}",
          repositoryToken: "{{trigger.token}}",
          githubToken: "{{trigger.token}}"
        },
        status: "idle"
      }
    },
    {
      id: "da_ai_coding_agent",
      type: "action",
      position: { x: 160, y: 0 },
      data: {
        label: "OpenShell Coding Agent",
        description: "Create the implementation plan, wait for approval, then execute the approved plan in the same OpenShell sandbox flow.",
        type: "action",
        config: {
          actionType: "durable/run",
          mode: "plan_mode",
          profile: "feature-delivery",
          provider: "",
          keepSandbox: "true",
          prompt: "{{trigger.task}}",
          expectedOutput: "A concise implementation summary, changed-file list, and verification results.",
          toolPolicy: "all",
          writePolicy: "workspace-only",
          shellPolicy: "workspace-safe",
          executeAfterApproval: "true",
          approvalTimeoutMinutes: "60",
          workspaceRef,
          repoUrl: "https://github.com/{{trigger.owner}}/{{trigger.repo}}.git",
          repoBranch: "{{trigger.branch}}",
          repoToken: "{{trigger.token}}",
          sandboxRepoPath,
          cwd: sandboxRepoPath,
          maxTurns: "80",
          timeoutMinutes: "60",
          stopCondition: "The requested change is implemented in the selected repository, verification is complete, and the final response includes changed files and a concise summary."
        },
        status: "idle"
      }
    }
  ]);
}
function buildAiCodingAgentEdges() {
  return [
    {
      id: "e_ai_coding_agent_1",
      type: "animated",
      source: "tr_ai_coding_agent",
      target: "pf_ai_coding_agent",
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: "e_ai_coding_agent_2",
      type: "animated",
      source: "pf_ai_coding_agent",
      target: "cl_ai_coding_agent",
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: "e_ai_coding_agent_3",
      type: "animated",
      source: "cl_ai_coding_agent",
      target: "da_ai_coding_agent",
      sourceHandle: null,
      targetHandle: null
    }
  ];
}
function buildAgentSystemDemoNodes(input) {
  const workspaceRef = "{{@pf_agent_system_demo:Workspace Profile.workspaceRef}}";
  const clonePath = "{{@cl_agent_system_demo:Workspace Clone.clonePath}}";
  const sandboxRepoPath = "/sandbox/stacks";
  const cloneConfig = {
    actionType: "workspace/clone",
    workspaceRef,
    repositoryOwner: "PittampalliOrg",
    repositoryRepo: "stacks",
    repositoryBranch: "main"
  };
  if (input?.connectionExternalId) {
    cloneConfig.auth = `{{connections['${input.connectionExternalId}']}}`;
  }
  if (input?.connectionId) {
    cloneConfig.integrationId = input.connectionId;
  }
  const featureDeliveryPrompt = `Repository root: ${sandboxRepoPath}
Always operate relative to this repository root for file and directory paths.

Plan and implement a small developer utility in this repository. Create a new Python script at scripts/workflow_builder_demo_report.py. The script should recursively scan packages/components/active-development/manifests for YAML files whose filename contains any of: workflow-builder, workflow-orchestrator, function-router, openshell-agent-runtime, or openshell-langgraph-dapr. Print a JSON object with a sorted list of matching relative file paths and a count. Use only the Python standard library, add a clear main entrypoint, and avoid modifying unrelated files.

## Stop Condition
The new Python utility exists, verification commands pass, and the final response includes changed files and a concise implementation summary.

Execute autonomously until the stop condition is satisfied. Do not ask for confirmation before proceeding.`;
  return normalizeWorkflowNodes([
    {
      id: "tr_agent_system_demo",
      type: "trigger",
      position: { x: -760, y: 0 },
      data: {
        label: "Manual Trigger",
        description: "",
        type: "trigger",
        config: { triggerType: "Manual" },
        status: "idle"
      }
    },
    {
      id: "pf_agent_system_demo",
      type: "action",
      position: { x: -480, y: 0 },
      data: {
        label: "Workspace Profile",
        description: "Create an execution-scoped sandbox for the agent system demo.",
        type: "action",
        config: {
          actionType: "workspace/profile",
          name: "workflow-agent-system-demo",
          enabledTools: '["read","list","bash"]',
          requireReadBeforeWrite: "true",
          commandTimeoutMs: "120000"
        },
        status: "idle"
      }
    },
    {
      id: "cl_agent_system_demo",
      type: "action",
      position: { x: -180, y: 0 },
      data: {
        label: "Workspace Clone",
        description: "Clone PittampalliOrg/stacks into the sandbox.",
        type: "action",
        config: cloneConfig,
        status: "idle"
      }
    },
    {
      id: "cm_agent_system_demo_tree",
      type: "action",
      position: { x: 140, y: 0 },
      data: {
        label: "Show Repo Tree",
        description: "Print a repo tree before the agents start so the run has a visible sandbox step.",
        type: "action",
        config: {
          actionType: "workspace/command",
          workspaceRef,
          timeoutMs: "120000",
          command: `set -euo pipefail
TARGET='${clonePath}'
echo "CLONE_PATH=$TARGET"
if command -v tree >/dev/null 2>&1; then
	tree -a -L 3 "$TARGET"
else
	find "$TARGET" -maxdepth 3 -print | LC_ALL=C sort | sed "s#^$TARGET#.#"
fi`
        },
        status: "idle"
      }
    },
    {
      id: "da_agent_system_demo",
      type: "action",
      position: { x: 500, y: 0 },
      data: {
        label: "OpenShell Feature Delivery",
        description: "Run the OpenShell coding agent through plan, approval, implementation, and verification.",
        type: "action",
        config: {
          actionType: "durable/run",
          mode: "plan_mode",
          profile: "feature-delivery",
          provider: "",
          keepSandbox: "true",
          prompt: featureDeliveryPrompt,
          expectedOutput: "A verified Python utility plus plan artifact, patch artifact, snapshot refs, and changed-file summary.",
          verifyCommands: `python -m py_compile scripts/workflow_builder_demo_report.py
python scripts/workflow_builder_demo_report.py`,
          toolPolicy: "all",
          writePolicy: "workspace-only",
          shellPolicy: "workspace-safe",
          executeAfterApproval: "true",
          approvalTimeoutMinutes: "60",
          workspaceRef,
          repoUrl: "https://github.com/PittampalliOrg/stacks.git",
          repoBranch: "main",
          sandboxRepoPath,
          cwd: sandboxRepoPath,
          maxTurns: "60",
          timeoutMinutes: "45",
          stopCondition: "The new Python utility exists, verification commands pass, and the final response includes changed files and a concise implementation summary."
        },
        status: "idle"
      }
    }
  ]);
}
function buildAgentSystemDemoEdges() {
  return [
    {
      id: "e_agent_system_demo_1",
      type: "animated",
      source: "tr_agent_system_demo",
      target: "pf_agent_system_demo",
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: "e_agent_system_demo_2",
      type: "animated",
      source: "pf_agent_system_demo",
      target: "cl_agent_system_demo",
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: "e_agent_system_demo_3",
      type: "animated",
      source: "cl_agent_system_demo",
      target: "cm_agent_system_demo_tree",
      sourceHandle: null,
      targetHandle: null
    },
    {
      id: "e_agent_system_demo_4",
      type: "animated",
      source: "cm_agent_system_demo_tree",
      target: "da_agent_system_demo",
      sourceHandle: null,
      targetHandle: null
    }
  ];
}
var THREE_B_ONE_B_CLI_RUNTIMES = [
  {
    runtime: "codex-cli",
    label: "Codex CLI"
  },
  {
    runtime: "claude-code-cli",
    label: "Claude Code CLI"
  },
  {
    runtime: "agy-cli",
    label: "Antigravity CLI"
  }
];
var THREE_B_ONE_B_CLI_RUNTIME_OPTIONS = THREE_B_ONE_B_CLI_RUNTIMES.map(
  (item) => ({
    label: item.label,
    value: item.runtime
  })
);
var THREE_B_ONE_B_CLI_DEFAULT_RUNTIME = parseCliRuntime(
  process.env.SEED_3B1B_CLI_DEFAULT_RUNTIME?.trim() || "codex-cli"
);
var THREE_B_ONE_B_CLI_SELECTED_BUILD_OUTPUT = "${ .build_3b1b_animation }";
var THREE_B_ONE_B_CLI_SELECTED_BUILD_RUNTIME_SANDBOX_NAME = "${ .build_3b1b_animation.runtimeSandboxName // null }";
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
function parseCliRuntime(value) {
  if (value === "codex-cli" || value === "claude-code-cli" || value === "agy-cli") {
    return value;
  }
  throw new Error(
    `Invalid SEED_3B1B_CLI_DEFAULT_RUNTIME "${value}". Expected codex-cli, claude-code-cli, or agy-cli.`
  );
}
function selectedCliRuntimeExpression() {
  return `\${ .trigger.cliRuntime // "${THREE_B_ONE_B_CLI_DEFAULT_RUNTIME}" }`;
}
var THREE_B_ONE_B_BUILD_PROMPT = [
  '${ .trigger.animationDescription + " - Build a self-contained browser animation in ',
  THREE_B_ONE_B_APP_DIR,
  " with index.html, styles.css, script.js, and README.md. ",
  "Use Canvas or SVG so the result runs via a simple static file server. ",
  "The browser animation is the required deliverable. ",
  'Use stable DOM ids for validation: the main canvas must be <canvas id=\\"canvas\\">, ',
  'the play/pause control <button id=\\"btn-play\\">, ',
  'the restart control <button id=\\"btn-restart\\">. ',
  "Do NOT install Manim; if a scene is useful, include scene.py as optional source only. ",
  "Do not start any preview server; the downstream browser/validate and ",
  "browser/start-preview steps will do that. ",
  "The page must work when served as static files (no module imports outside relative script.js). ",
  "Do NOT create a package.json; that triggers the runtime's npm-run-dev fallback ",
  "which expects flags python3's http.server doesn't recognize. ",
  'Final answer: list the files created and a one-paragraph outline of the animation logic." }'
].join("");
var THREE_B_ONE_B_CLI_BUILD_STOP_CONDITION = [
  `Stop only when ${THREE_B_ONE_B_APP_DIR} exists with index.html, styles.css, script.js, and README.md `,
  "created or updated through file-writing tools. ",
  "index.html must include canvas#canvas, button#btn-play, and button#btn-restart. ",
  "The final answer must list the files created and outline the animation logic."
].join("");
function makeThreeBOneBWorkspaceProfileTask() {
  return {
    call: "workspace/profile",
    with: {
      name: "three-b-one-b-animation",
      rootPath: "/sandbox",
      sandboxTemplate: '${ .trigger.sandboxTemplate // "dapr-agent" }',
      ttlSeconds: 7200,
      keepAfterRun: true,
      managedBy: "workflow-builder:demos:3b1b-animation",
      commandTimeoutMs: 9e5,
      timeoutMs: 12e5,
      enabledTools: [
        "execute_command",
        "read_file",
        "write_file",
        "edit_file",
        "list_files",
        "mkdir",
        "file_stat"
      ],
      sandboxPolicy: {
        mode: "per-run",
        template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
        ttlSeconds: 7200,
        keepAfterRun: true
      }
    }
  };
}
function makeThreeBOneBBuildTask(agentRef) {
  if (!Number.isInteger(agentRef.version) || agentRef.version <= 0) {
    throw new Error(
      `SEED_3B1B_AGENT_VERSION must be a positive integer; got ${process.env.SEED_3B1B_AGENT_VERSION}`
    );
  }
  return {
    call: "durable/run",
    with: {
      mode: "execute_direct",
      cwd: "/sandbox",
      sandboxName: "${ .workspace_profile.sandboxName }",
      workspaceRef: "${ .workspace_profile.workspaceRef }",
      outputSync: {
        workspaceRef: "${ .workspace_profile.workspaceRef }",
        paths: [
          {
            source: THREE_B_ONE_B_APP_DIR,
            target: THREE_B_ONE_B_APP_DIR
          }
        ],
        timeoutMs: 12e4
      },
      sandboxPolicy: {
        mode: "per-run",
        template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
        ttlSeconds: 7200,
        keepAfterRun: true
      },
      body: {
        agentRef,
        prompt: THREE_B_ONE_B_BUILD_PROMPT,
        overrides: {
          cwd: "/sandbox",
          maxTurns: 60,
          timeoutMinutes: 60
        }
      }
    }
  };
}
function makeThreeBOneBBrowserValidateTask() {
  return {
    call: "browser/validate",
    with: {
      workspaceRef: THREE_B_ONE_B_BUILD_OUTPUT_WORKSPACE_REF,
      sandboxName: THREE_B_ONE_B_BUILD_OUTPUT_SANDBOX_NAME,
      repoPath: THREE_B_ONE_B_APP_DIR,
      installCommand: "",
      baseUrl: "http://127.0.0.1:0",
      steps: [
        {
          id: "initial",
          label: "Animation loaded",
          action: "visit",
          path: "/",
          goal: "Initial render of the canvas before any interaction.",
          waitForSelector: "canvas#canvas",
          pauseMs: 1500,
          fullPage: true
        },
        {
          id: "after-play",
          label: "After play",
          action: "click",
          selector: "button#btn-play",
          goal: "Trigger the play control once.",
          waitForSelector: "canvas#canvas",
          pauseMs: 2e3,
          fullPage: true
        },
        {
          id: "after-second-play",
          label: "After second play",
          action: "click",
          selector: "button#btn-play",
          goal: "Trigger the play control again to capture mid-animation state.",
          waitForSelector: "canvas#canvas",
          pauseMs: 1500,
          fullPage: true
        },
        {
          id: "after-restart",
          label: "After restart",
          action: "click",
          selector: "button#btn-restart",
          goal: "Restart the animation and capture the reset state.",
          waitForSelector: "canvas#canvas",
          pauseMs: 1500,
          fullPage: true
        }
      ],
      captureVideo: true,
      captureTrace: true,
      viewportPreset: "desktop",
      captureMode: "demo",
      demoTitle: '${ "3Blue1Brown-style animation: " + .trigger.animationDescription }',
      demoSummary: "Generated 3Blue1Brown-style browser animation; browser/validate captured initial / play / second play / restart states from the retained per-run sandbox.",
      metadata: {
        appPath: THREE_B_ONE_B_APP_DIR,
        workflowStage: "post-3b1b-animation",
        runtimeSandboxName: "${ .build_3b1b_animation.runtimeSandboxName // null }"
      },
      timeoutMs: 9e5
    }
  };
}
function makeThreeBOneBStartPreviewTask() {
  return {
    call: "browser/start-preview",
    with: {
      body: {
        input: {
          previewId: '${ "3b1b-animation-preview-" + (.runtime.dbExecutionId // .workspace_profile.workspaceRef) }',
          repoPath: THREE_B_ONE_B_APP_DIR,
          rootPath: "/sandbox",
          workingDir: "/sandbox",
          baseUrl: "http://127.0.0.1:0",
          keepAlive: true,
          timeoutSeconds: 7200,
          timeoutMs: 72e5,
          sandboxName: THREE_B_ONE_B_BUILD_OUTPUT_SANDBOX_NAME,
          workspaceRef: THREE_B_ONE_B_BUILD_OUTPUT_WORKSPACE_REF
        }
      }
    }
  };
}
function buildThreeBOneBWorkflowSpec(agentRef) {
  return {
    document: {
      dsl: "1.0.0",
      namespace: "workflow-builder.demos",
      name: THREE_B_ONE_B_WORKFLOW_ID,
      version: "1.0.0",
      title: THREE_B_ONE_B_WORKFLOW_NAME,
      summary: THREE_B_ONE_B_WORKFLOW_DESCRIPTION,
      "x-workflow-builder": {
        architecture: "per-agent-runtime+session-workflow-bridge+browser-validate-capture",
        notes: "Adapted from the legacy 3pvh53PpHSiz-OoEeSW4z fixture for the per-agent-runtime architecture. Single agent step builds index.html / styles.css / script.js / README.md; browser/validate boots the static-file server and captures a 4-screenshot demo. Sandbox is retained so the live preview proxy can attach after completion.",
        triggerInputs: {
          animationDescription: "Required. Plain-language description of the 3Blue1Brown-style animation to build.",
          sandboxTemplate: "Optional override (default 'dapr-agent'). Only set this if the cluster has a dedicated animation template installed."
        },
        input: {
          fields: {
            animationDescription: {
              type: "textarea",
              label: "Animation description",
              description: "Describe the 3Blue1Brown-style animation the agent should build.",
              defaultValue: "Create a concise 3Blue1Brown-style derivative animation for x^2"
            }
          }
        }
      }
    },
    do: [
      { workspace_profile: makeThreeBOneBWorkspaceProfileTask() },
      { build_3b1b_animation: makeThreeBOneBBuildTask(agentRef) },
      { browser_validate_capture: makeThreeBOneBBrowserValidateTask() },
      { start_preview: makeThreeBOneBStartPreviewTask() }
    ],
    output: {
      as: {
        appPath: THREE_B_ONE_B_APP_DIR,
        workspaceRef: THREE_B_ONE_B_BUILD_OUTPUT_WORKSPACE_REF,
        sandboxName: THREE_B_ONE_B_BUILD_OUTPUT_SANDBOX_NAME,
        runtimeSandboxName: "${ .build_3b1b_animation.runtimeSandboxName // null }",
        animation: "${ .build_3b1b_animation }",
        screenshots: "${ .browser_validate_capture }",
        preview: "${ .start_preview }"
      }
    },
    input: {
      schema: {
        document: {
          type: "object",
          required: ["animationDescription"],
          properties: {
            animationDescription: {
              type: "string",
              title: "Animation description",
              description: "Describe the 3Blue1Brown-style animation the agent should build.",
              default: "Create a concise 3Blue1Brown-style derivative animation for x^2"
            }
          }
        },
        format: "json"
      }
    }
  };
}
function buildThreeBOneBWorkflowNodes() {
  return [
    {
      id: "trigger",
      type: "trigger",
      position: { x: 80, y: 60 },
      data: {
        label: "Animation request trigger",
        description: "Receives animationDescription for the 3Blue1Brown-style animation."
      }
    },
    {
      id: "workspace_profile",
      type: "action",
      position: { x: 80, y: 200 },
      data: {
        label: "Provision retained sandbox",
        actionType: "workspace/profile",
        description: "Stand up a per-run sandbox with file/exec tools; keepAfterRun=true so the live preview can attach after the run."
      }
    },
    {
      id: "build_3b1b_animation",
      type: "action",
      position: { x: 80, y: 340 },
      data: {
        label: "Build 3B1B animation",
        actionType: "durable/run",
        description: "Agent generates index.html / styles.css / script.js / README.md with stable DOM ids for validation."
      }
    },
    {
      id: "browser_validate_capture",
      type: "action",
      position: { x: 80, y: 480 },
      data: {
        label: "Capture animation walkthrough",
        actionType: "browser/validate",
        description: "Boot the generated static files and capture initial / play / second play / restart screenshots."
      }
    },
    {
      id: "start_preview",
      type: "action",
      position: { x: 80, y: 620 },
      data: {
        label: "Start live preview",
        actionType: "browser/start-preview",
        description: "Pre-create the live-preview proxy with correct repoPath/rootPath."
      }
    }
  ];
}
function buildThreeBOneBWorkflowEdges() {
  return [
    {
      id: "e_three_b_one_b_1",
      source: "trigger",
      target: "workspace_profile",
      type: "default"
    },
    {
      id: "e_three_b_one_b_2",
      source: "workspace_profile",
      target: "build_3b1b_animation",
      type: "default"
    },
    {
      id: "e_three_b_one_b_3",
      source: "build_3b1b_animation",
      target: "browser_validate_capture",
      type: "default"
    },
    {
      id: "e_three_b_one_b_4",
      source: "browser_validate_capture",
      target: "start_preview",
      type: "default"
    }
  ];
}
function makeThreeBOneBCliWorkspaceProfileTask() {
  const task = cloneJson(makeThreeBOneBWorkspaceProfileTask());
  const withBlock = isRecord2(task.with) ? task.with : {};
  task.with = withBlock;
  withBlock.sandboxTemplate = "dapr-agent";
  const sandboxPolicy = isRecord2(withBlock.sandboxPolicy) ? withBlock.sandboxPolicy : {};
  withBlock.sandboxPolicy = sandboxPolicy;
  sandboxPolicy.template = "dapr-agent";
  return task;
}
function makeThreeBOneBCliBuildTask() {
  return {
    call: "durable/run",
    with: {
      mode: "execute_direct",
      cwd: "/sandbox",
      sandboxName: "${ .workspace_profile.sandboxName }",
      workspaceRef: "${ .workspace_profile.workspaceRef }",
      outputSync: {
        workspaceRef: "${ .workspace_profile.workspaceRef }",
        paths: [
          {
            source: THREE_B_ONE_B_APP_DIR,
            target: THREE_B_ONE_B_APP_DIR
          }
        ],
        timeoutSeconds: 120
      },
      sandboxPolicy: {
        mode: "per-run",
        template: "dapr-agent",
        ttlSeconds: 7200,
        keepAfterRun: true
      },
      body: {
        agentRef: {
          slug: selectedCliRuntimeExpression()
        },
        prompt: THREE_B_ONE_B_BUILD_PROMPT,
        stopCondition: THREE_B_ONE_B_CLI_BUILD_STOP_CONDITION,
        requireFileChanges: true,
        overrides: {
          cwd: "/sandbox",
          maxTurns: 60,
          timeoutMinutes: 60
        }
      }
    }
  };
}
function makeThreeBOneBCliVerifyTask() {
  return {
    call: "workspace/command",
    with: {
      workspaceRef: THREE_B_ONE_B_BUILD_OUTPUT_WORKSPACE_REF,
      cwd: "/sandbox",
      timeoutMs: 12e4,
      command: [
        "set -eu",
        `app=${JSON.stringify(THREE_B_ONE_B_APP_DIR)}`,
        'test -f "$app/index.html"',
        'test -f "$app/styles.css"',
        'test -f "$app/script.js"',
        'test -f "$app/README.md"',
        'node --check "$app/script.js"',
        'grep -q "id=\\"canvas\\"" "$app/index.html"',
        'grep -q "id=\\"btn-play\\"" "$app/index.html"',
        'grep -q "id=\\"btn-restart\\"" "$app/index.html"',
        'find "$app" -maxdepth 1 -type f -printf "%f %s bytes\\n" | sort'
      ].join("\n")
    }
  };
}
function makeThreeBOneBCliBrowserValidateTask() {
  return {
    call: "browser/validate",
    with: {
      workspaceRef: THREE_B_ONE_B_BUILD_OUTPUT_WORKSPACE_REF,
      sandboxName: THREE_B_ONE_B_BUILD_OUTPUT_SANDBOX_NAME,
      repoPath: THREE_B_ONE_B_APP_DIR,
      rootPath: "/sandbox",
      workingDir: "/sandbox",
      installCommand: "",
      baseUrl: "http://127.0.0.1:0",
      steps: [
        {
          id: "initial",
          label: "Animation loaded",
          action: "visit",
          path: "/",
          goal: "Initial render of the canvas before any interaction.",
          waitForSelector: "canvas#canvas",
          pauseMs: 1500,
          fullPage: true
        },
        {
          id: "after-play",
          label: "After play",
          action: "click",
          selector: "button#btn-play",
          goal: "Trigger the play control once.",
          waitForSelector: "canvas#canvas",
          pauseMs: 2e3,
          fullPage: true
        },
        {
          id: "after-second-play",
          label: "After second play",
          action: "click",
          selector: "button#btn-play",
          goal: "Trigger the play control again to capture mid-animation state.",
          waitForSelector: "canvas#canvas",
          pauseMs: 1500,
          fullPage: true
        },
        {
          id: "after-restart",
          label: "After restart",
          action: "click",
          selector: "button#btn-restart",
          goal: "Restart the animation and capture the reset state.",
          waitForSelector: "canvas#canvas",
          pauseMs: 1500,
          fullPage: true
        }
      ],
      captureVideo: true,
      captureTrace: true,
      viewportPreset: "desktop",
      captureMode: "demo",
      demoTitle: '${ "3Blue1Brown-style animation: " + .trigger.animationDescription }',
      demoSummary: "Generated 3Blue1Brown-style browser animation from a CLI-agent run; browser/validate captured initial / play / second play / restart states from the retained workspace.",
      metadata: {
        appPath: THREE_B_ONE_B_APP_DIR,
        workflowStage: "post-cli-3b1b-animation",
        runtimeSandboxName: THREE_B_ONE_B_CLI_SELECTED_BUILD_RUNTIME_SANDBOX_NAME,
        selectedCliRuntime: selectedCliRuntimeExpression()
      },
      timeoutMs: 9e5
    }
  };
}
function makeThreeBOneBCliStartPreviewTask() {
  return {
    call: "browser/start-preview",
    with: {
      body: {
        input: {
          previewId: '${ "3b1b-cli-animation-preview-" + (.runtime.dbExecutionId // .workspace_profile.workspaceRef) }',
          repoPath: THREE_B_ONE_B_APP_DIR,
          rootPath: "/sandbox",
          workingDir: "/sandbox",
          baseUrl: "http://127.0.0.1:0",
          keepAlive: true,
          timeoutSeconds: 7200,
          timeoutMs: 72e5,
          sandboxName: THREE_B_ONE_B_BUILD_OUTPUT_SANDBOX_NAME,
          workspaceRef: THREE_B_ONE_B_BUILD_OUTPUT_WORKSPACE_REF,
          installCommand: "",
          devServerCommand: ""
        }
      }
    }
  };
}
function buildThreeBOneBCliWorkflowSpec() {
  return {
    document: {
      dsl: "1.0.0",
      namespace: "workflow-builder.demos",
      name: THREE_B_ONE_B_CLI_WORKFLOW_ID,
      version: "1.0.0",
      title: THREE_B_ONE_B_CLI_WORKFLOW_NAME,
      summary: THREE_B_ONE_B_CLI_WORKFLOW_DESCRIPTION,
      "x-workflow-builder": {
        architecture: "per-agent-runtime+cli-runtime-selector+session-workflow-bridge+browser-validate-capture+static-preview",
        notes: "CLI variant of the canonical 3Blue1Brown workflow. The cliRuntime trigger input resolves one durable/run agentRef.slug before dispatch; outputSync copies the app into the retained OpenShell workspace for verification, browser capture, and live preview.",
        triggerInputs: {
          animationDescription: "Required. Plain-language description of the 3Blue1Brown-style animation to build.",
          cliRuntime: "Optional. Selects the CLI agent runtime: codex-cli, claude-code-cli, or agy-cli."
        },
        input: {
          fields: {
            cliRuntime: {
              type: "select",
              label: "CLI agent",
              description: "Choose which CLI agent builds the animation.",
              defaultValue: THREE_B_ONE_B_CLI_DEFAULT_RUNTIME,
              options: THREE_B_ONE_B_CLI_RUNTIME_OPTIONS
            },
            animationDescription: {
              type: "textarea",
              label: "Animation description",
              description: "Describe the 3Blue1Brown-style animation the agent should build.",
              defaultValue: "Create a concise 3Blue1Brown-style derivative animation for x^2"
            }
          }
        }
      }
    },
    do: [
      { workspace_profile: makeThreeBOneBCliWorkspaceProfileTask() },
      { build_3b1b_animation: makeThreeBOneBCliBuildTask() },
      { verify_copied_animation: makeThreeBOneBCliVerifyTask() },
      { browser_validate_capture: makeThreeBOneBCliBrowserValidateTask() },
      { start_preview: makeThreeBOneBCliStartPreviewTask() }
    ],
    output: {
      as: {
        appPath: THREE_B_ONE_B_APP_DIR,
        workspaceRef: THREE_B_ONE_B_BUILD_OUTPUT_WORKSPACE_REF,
        sandboxName: THREE_B_ONE_B_BUILD_OUTPUT_SANDBOX_NAME,
        runtimeSandboxName: THREE_B_ONE_B_CLI_SELECTED_BUILD_RUNTIME_SANDBOX_NAME,
        selectedCliRuntime: selectedCliRuntimeExpression(),
        animation: THREE_B_ONE_B_CLI_SELECTED_BUILD_OUTPUT,
        verification: "${ .verify_copied_animation }",
        screenshots: "${ .browser_validate_capture }",
        preview: "${ .start_preview }"
      }
    },
    input: {
      schema: {
        document: {
          type: "object",
          required: ["animationDescription"],
          properties: {
            cliRuntime: {
              type: "string",
              title: "CLI agent",
              description: "Selects the CLI agent runtime for the build step.",
              enum: THREE_B_ONE_B_CLI_RUNTIMES.map((item) => item.runtime),
              default: THREE_B_ONE_B_CLI_DEFAULT_RUNTIME
            },
            animationDescription: {
              type: "string",
              title: "Animation description",
              description: "Describe the 3Blue1Brown-style animation the agent should build.",
              default: "Create a concise 3Blue1Brown-style derivative animation for x^2"
            }
          }
        },
        format: "json"
      }
    }
  };
}
function buildThreeBOneBCliWorkflowNodes() {
  return [
    {
      id: "trigger",
      type: "trigger",
      position: { x: 80, y: 60 },
      data: {
        label: "Animation request trigger",
        description: "Receives animationDescription and cliRuntime for the 3Blue1Brown-style animation."
      }
    },
    {
      id: "workspace_profile",
      type: "action",
      position: { x: 80, y: 200 },
      data: {
        label: "Provision retained sandbox",
        actionType: "workspace/profile",
        description: "Stand up a per-run sandbox with file/exec tools; keepAfterRun=true so the live preview can attach after the run."
      }
    },
    {
      id: "build_3b1b_animation",
      type: "action",
      position: { x: 80, y: 340 },
      data: {
        label: "Build with selected CLI",
        actionType: "durable/run",
        description: "Resolve cliRuntime to a managed CLI agent and generate the browser animation."
      }
    },
    {
      id: "verify_copied_animation",
      type: "action",
      position: { x: 80, y: 480 },
      data: {
        label: "Verify copied animation",
        actionType: "workspace/command",
        description: "Run file and syntax checks against the retained workspace after CLI output sync."
      }
    },
    {
      id: "browser_validate_capture",
      type: "action",
      position: { x: 80, y: 620 },
      data: {
        label: "Capture animation walkthrough",
        actionType: "browser/validate",
        description: "Boot a static server against the copied files and capture initial / play / second play / restart screenshots."
      }
    },
    {
      id: "start_preview",
      type: "action",
      position: { x: 80, y: 760 },
      data: {
        label: "Start live preview",
        actionType: "browser/start-preview",
        description: "Start a keep-alive preview proxy for the retained workspace so the run page can open the generated animation."
      }
    }
  ];
}
function buildThreeBOneBCliWorkflowEdges() {
  const ordered = [
    "trigger",
    "workspace_profile",
    "build_3b1b_animation",
    "verify_copied_animation",
    "browser_validate_capture",
    "start_preview"
  ];
  return ordered.slice(0, -1).map((source, index2) => ({
    id: `e_cli_3b1b_${index2 + 1}`,
    source,
    target: ordered[index2 + 1],
    type: "default"
  }));
}
function selectedGameRuntimeExpression() {
  return `\${ .trigger.cliRuntime // "${SVELTEKIT_GAME_DEFAULT_RUNTIME}" }`;
}
function makeSvelteKitGameWorkspaceProfileTask() {
  return {
    call: "workspace/profile",
    with: {
      name: "sveltekit-game",
      rootPath: "/sandbox",
      sandboxTemplate: '${ .trigger.sandboxTemplate // "dapr-agent" }',
      ttlSeconds: 7200,
      keepAfterRun: true,
      managedBy: "workflow-builder:demos:sveltekit-game",
      commandTimeoutMs: 9e5,
      timeoutMs: 12e5,
      enabledTools: [
        "execute_command",
        "read_file",
        "write_file",
        "edit_file",
        "list_files",
        "mkdir",
        "file_stat"
      ],
      sandboxPolicy: {
        mode: "per-run",
        template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
        ttlSeconds: 7200,
        keepAfterRun: true
      }
    }
  };
}
function makeSvelteKitGameBuildTask() {
  return {
    call: "durable/run",
    with: {
      mode: "execute_direct",
      cwd: "/sandbox",
      sandboxName: "${ .workspace_profile.sandboxName }",
      workspaceRef: "${ .workspace_profile.workspaceRef }",
      // The CLI agent builds in its own per-session sandbox. Sync ONLY the
      // small static adapter-static `build/` output into the retained
      // workspace (the whole project incl. node_modules would exceed the
      // 64 MiB outputSync ceiling). The preview serves these static files
      // directly — no npm install, no dev server, no node_modules.
      outputSync: {
        workspaceRef: "${ .workspace_profile.workspaceRef }",
        paths: [
          {
            source: SVELTEKIT_GAME_BUILD_DIR,
            target: SVELTEKIT_GAME_SITE_DIR
          }
        ],
        timeoutSeconds: 300
      },
      sandboxPolicy: {
        mode: "per-run",
        template: "dapr-agent",
        ttlSeconds: 7200,
        keepAfterRun: true
      },
      body: {
        agentRef: {
          slug: selectedGameRuntimeExpression()
        },
        prompt: SVELTEKIT_GAME_BUILD_PROMPT,
        // Goal mode: drives a multi-turn run toward the objective until the
        // CLI's own goal evaluator reports completion (session.goal_completed),
        // at which point the bridge auto-terminates and the parent resumes.
        goalSpec: {
          objective: SVELTEKIT_GAME_GOAL_OBJECTIVE,
          maxIterations: `\${ .trigger.maxIterations // ${SVELTEKIT_GAME_DEFAULT_MAX_ITERATIONS} }`,
          // 0 ⇒ no budget (parsePositiveInteger treats <=0 as null). Using
          // `// 0` (not `// null`) keeps a real default so the trigger field
          // is satisfied by applyWorkflowInputDefaults (a null default would
          // be flagged as a missing required field).
          tokenBudget: "${ .trigger.tokenBudget // 0 }"
        },
        overrides: {
          cwd: "/sandbox",
          maxTurns: 80,
          timeoutMinutes: 90
        }
      }
    }
  };
}
function makeSvelteKitGameVerifyTask() {
  return {
    call: "workspace/command",
    with: {
      workspaceRef: SVELTEKIT_GAME_OUTPUT_WORKSPACE_REF,
      cwd: "/sandbox",
      timeoutMs: 12e4,
      command: [
        "set -eu",
        `site=${JSON.stringify(SVELTEKIT_GAME_SITE_DIR)}`,
        'test -f "$site/index.html"',
        'echo "static site present:"',
        'find "$site" -maxdepth 2 -type f -printf "%P %s bytes\\n" | sort | head -60'
      ].join("\n")
    }
  };
}
function makeSvelteKitGameBrowserValidateTask() {
  return {
    call: "browser/validate",
    with: {
      workspaceRef: SVELTEKIT_GAME_OUTPUT_WORKSPACE_REF,
      sandboxName: SVELTEKIT_GAME_OUTPUT_SANDBOX_NAME,
      repoPath: SVELTEKIT_GAME_SITE_DIR,
      rootPath: "/sandbox",
      workingDir: SVELTEKIT_GAME_SITE_DIR,
      installCommand: "",
      baseUrl: SVELTEKIT_GAME_BASE_URL,
      steps: [
        {
          id: "initial",
          label: "Game loaded",
          action: "visit",
          path: "/",
          goal: "Initial render of the game shell before starting.",
          waitForSelector: '[data-test="game-root"]',
          pauseMs: 2500,
          fullPage: true
        },
        {
          id: "started",
          label: "Game started",
          action: "click",
          selector: '[data-test="start"]',
          goal: "Start a new game and show the board.",
          waitForSelector: '[data-test="board"]',
          pauseMs: 1500,
          fullPage: true
        },
        {
          id: "rotate",
          label: "After rotate",
          action: "click",
          selector: '[data-test="rotate"]',
          goal: "Rotate the active piece via the on-screen control.",
          waitForSelector: '[data-test="board"]',
          pauseMs: 900,
          fullPage: true
        },
        {
          id: "move",
          label: "After move",
          action: "click",
          selector: '[data-test="move-left"]',
          goal: "Move the active piece via the on-screen control.",
          waitForSelector: '[data-test="board"]',
          pauseMs: 900,
          fullPage: true
        },
        {
          id: "drop",
          label: "After drop + score",
          action: "click",
          selector: '[data-test="drop"]',
          goal: "Drop the piece and capture the updated score.",
          waitForSelector: '[data-test="score"]',
          pauseMs: 2e3,
          fullPage: true
        }
      ],
      captureVideo: true,
      captureTrace: true,
      viewportPreset: "desktop",
      captureMode: "demo",
      demoTitle: '${ "SvelteKit game: " + (.trigger.gameDescription // "Tetris") }',
      demoSummary: "Goal-driven agent built a SvelteKit game as a static site; browser/validate served the static build and captured load / start / rotate / move / drop states from the retained workspace.",
      metadata: {
        appPath: SVELTEKIT_GAME_APP_DIR,
        workflowStage: "post-sveltekit-game-build",
        runtimeSandboxName: "${ .build_game.runtimeSandboxName // null }",
        selectedCliRuntime: selectedGameRuntimeExpression()
      },
      timeoutMs: 12e5
    }
  };
}
function makeSvelteKitGameStartPreviewTask() {
  return {
    call: "browser/start-preview",
    with: {
      body: {
        input: {
          previewId: '${ "sveltekit-game-preview-" + (.runtime.dbExecutionId // .workspace_profile.workspaceRef) }',
          repoPath: SVELTEKIT_GAME_SITE_DIR,
          rootPath: "/sandbox",
          workingDir: SVELTEKIT_GAME_SITE_DIR,
          baseUrl: SVELTEKIT_GAME_BASE_URL,
          keepAlive: true,
          timeoutSeconds: 7200,
          timeoutMs: 72e5,
          sandboxName: SVELTEKIT_GAME_OUTPUT_SANDBOX_NAME,
          workspaceRef: SVELTEKIT_GAME_OUTPUT_WORKSPACE_REF,
          installCommand: "",
          devServerCommand: ""
        }
      }
    }
  };
}
function buildSvelteKitGameWorkflowSpec() {
  return {
    document: {
      dsl: "1.0.0",
      namespace: "workflow-builder.demos",
      name: SVELTEKIT_GAME_WORKFLOW_ID,
      version: "1.0.0",
      title: SVELTEKIT_GAME_WORKFLOW_NAME,
      summary: SVELTEKIT_GAME_WORKFLOW_DESCRIPTION,
      "x-workflow-builder": {
        architecture: "per-agent-runtime+cli-runtime-selector+goal-mode+session-workflow-bridge+browser-validate-capture+live-preview",
        notes: "Goal-mode showcase: an agent (default codex-cli) builds a real SvelteKit game as a STATIC site (@sveltejs/adapter-static) under a goalSpec objective whose completion criteria require the app to install, build, and be playable from the static output. The agent builds in its own sandbox; outputSync copies ONLY the small static build/ into the retained workspace (the whole project incl. node_modules would exceed the 64 MiB outputSync ceiling). browser/validate serves the static build to capture a walkthrough, and browser/start-preview keeps a static-file preview attached (the 3b1b static-serve pattern). First seeded workflow that exercises with.body.goalSpec.",
        triggerInputs: {
          gameDescription: "Optional. Plain-language description of the game to build (default: Tetris).",
          cliRuntime: "Optional. Selects the CLI agent runtime: codex-cli (default), claude-code-cli, or agy-cli.",
          maxIterations: "Optional. Goal-loop iteration cap (default 30).",
          tokenBudget: "Optional. Goal token budget; 0 = no budget (default)."
        },
        input: {
          fields: {
            cliRuntime: {
              type: "select",
              label: "CLI agent",
              description: "Choose which CLI agent builds the game in goal mode.",
              defaultValue: SVELTEKIT_GAME_DEFAULT_RUNTIME,
              options: THREE_B_ONE_B_CLI_RUNTIME_OPTIONS
            },
            gameDescription: {
              type: "textarea",
              label: "Game description",
              description: "Describe the SvelteKit game the agent should build. Leave as-is for a polished Tetris.",
              defaultValue: SVELTEKIT_GAME_DEFAULT_DESCRIPTION
            }
          }
        }
      }
    },
    do: [
      { workspace_profile: makeSvelteKitGameWorkspaceProfileTask() },
      { build_game: makeSvelteKitGameBuildTask() },
      { verify_app: makeSvelteKitGameVerifyTask() },
      { browser_validate_capture: makeSvelteKitGameBrowserValidateTask() },
      { start_preview: makeSvelteKitGameStartPreviewTask() }
    ],
    output: {
      as: {
        appPath: SVELTEKIT_GAME_APP_DIR,
        workspaceRef: SVELTEKIT_GAME_OUTPUT_WORKSPACE_REF,
        sandboxName: SVELTEKIT_GAME_OUTPUT_SANDBOX_NAME,
        runtimeSandboxName: "${ .build_game.runtimeSandboxName // null }",
        selectedCliRuntime: selectedGameRuntimeExpression(),
        build: "${ .build_game }",
        verification: "${ .verify_app }",
        screenshots: "${ .browser_validate_capture }",
        preview: "${ .start_preview }"
      }
    },
    input: {
      schema: {
        document: {
          type: "object",
          required: ["gameDescription"],
          properties: {
            cliRuntime: {
              type: "string",
              title: "CLI agent",
              description: "Selects the CLI agent runtime for the build step.",
              enum: THREE_B_ONE_B_CLI_RUNTIMES.map((item) => item.runtime),
              default: SVELTEKIT_GAME_DEFAULT_RUNTIME
            },
            gameDescription: {
              type: "string",
              title: "Game description",
              description: "Describe the SvelteKit game the agent should build.",
              default: SVELTEKIT_GAME_DEFAULT_DESCRIPTION
            },
            maxIterations: {
              type: "integer",
              title: "Max goal iterations",
              description: "Goal-loop iteration cap.",
              default: SVELTEKIT_GAME_DEFAULT_MAX_ITERATIONS,
              minimum: 1
            },
            tokenBudget: {
              type: "integer",
              title: "Goal token budget",
              description: "Token budget for the goal; 0 = no budget (default).",
              default: 0,
              minimum: 0
            },
            sandboxTemplate: {
              type: "string",
              title: "Sandbox template",
              description: "Override the OpenShell sandbox template (default 'dapr-agent', which has node/npm).",
              default: "dapr-agent"
            }
          }
        },
        format: "json"
      }
    }
  };
}
function buildSvelteKitGameWorkflowNodes() {
  return [
    {
      id: "trigger",
      type: "trigger",
      position: { x: 80, y: 60 },
      data: {
        label: "Game request trigger",
        description: "Receives gameDescription + cliRuntime (and optional goal tuning) for the SvelteKit game build."
      }
    },
    {
      id: "workspace_profile",
      type: "action",
      position: { x: 80, y: 200 },
      data: {
        label: "Provision retained sandbox",
        actionType: "workspace/profile",
        description: "Stand up a per-run dapr-agent sandbox (node/npm) with file/exec tools; keepAfterRun=true so the static preview can attach."
      }
    },
    {
      id: "build_game",
      type: "action",
      position: { x: 80, y: 340 },
      data: {
        label: "Build game (goal mode)",
        actionType: "durable/run",
        description: "Agent iterates under a goalSpec objective until the SvelteKit game installs, builds to a static site, and is playable; outputSync copies build/ to the workspace."
      }
    },
    {
      id: "verify_app",
      type: "action",
      position: { x: 80, y: 480 },
      data: {
        label: "Verify static build",
        actionType: "workspace/command",
        description: "Sanity-check the static build (index.html) landed in the retained workspace after outputSync."
      }
    },
    {
      id: "browser_validate_capture",
      type: "action",
      position: { x: 80, y: 620 },
      data: {
        label: "Capture game walkthrough",
        actionType: "browser/validate",
        description: "Serve the static build and capture load / start / rotate / move / drop screenshots."
      }
    },
    {
      id: "start_preview",
      type: "action",
      position: { x: 80, y: 760 },
      data: {
        label: "Start live preview",
        actionType: "browser/start-preview",
        description: "Keep a static-file preview proxy attached to the retained workspace so the run page can open the built game."
      }
    }
  ];
}
function buildSvelteKitGameWorkflowEdges() {
  const ordered = [
    "trigger",
    "workspace_profile",
    "build_game",
    "verify_app",
    "browser_validate_capture",
    "start_preview"
  ];
  return ordered.slice(0, -1).map((source, index2) => ({
    id: `e_sveltekit_game_${index2 + 1}`,
    source,
    target: ordered[index2 + 1],
    type: "default"
  }));
}
var CODING_GOAL_WORKFLOW_ID = process.env.SEED_CODING_GOAL_WORKFLOW_ID?.trim() || "coding-goal-eval-showcase";
var CODING_GOAL_WORKFLOW_NAME = "Evaluator-Gated Coding Goal";
var CODING_GOAL_WORKFLOW_DESCRIPTION = "Minimal goal-mode showcase for evaluator-gated completion: a dapr-agent-py agent writes a Python module to satisfy a spec, and its self-declared completion is independently verified by running deterministic acceptance tests in the workspace before the goal is marked complete (reject\u2192retry\u2192pass). No browser/preview.";
var CODING_GOAL_DEFAULT_AGENT_SLUG = process.env.SEED_CODING_GOAL_AGENT_SLUG?.trim() || "general-assistant";
var CODING_GOAL_DEFAULT_TASK = "Implement add(a, b) (returns a+b) and isPrime(n) in a Node.js (CommonJS) module.";
var CODING_GOAL_DEFAULT_MAX_ITERATIONS = 15;
var CODING_GOAL_EVIDENCE_COMMAND = `cd /sandbox && node -e 'const s=require("./solution.js"); const a=(c,m)=>{if(!c){console.error("FAIL: "+m);process.exit(1)}}; a(s.add(2,3)===5,"add(2,3)===5"); a(s.isPrime(2)===true,"isPrime(2)"); a(s.isPrime(1)===false,"isPrime(1)"); a(s.isPrime(0)===false,"isPrime(0)"); a(s.isPrime(-7)===false,"isPrime(-7)"); a(s.isPrime(13)===true,"isPrime(13)"); a(s.isPrime(15)===false,"isPrime(15)"); console.log("ALL PASS")'`;
var CODING_GOAL_OBJECTIVE = [
  '${ "Write /sandbox/solution.js (Node.js CommonJS) that satisfies: " + (.trigger.task // "',
  CODING_GOAL_DEFAULT_TASK,
  '") + ". It must module.exports an add(a, b) returning a+b, and an isPrime(n) returning true ONLY for prime integers >= 2 (false for 0, 1, all negatives, and composites). The goal is COMPLETE only when the acceptance test passes (exit 0). Do not weaken, delete, or special-case around the test." }'
].join("");
var CODING_GOAL_PROMPT = [
  '${ "Write /sandbox/solution.js per the active goal: " + (.trigger.task // "',
  CODING_GOAL_DEFAULT_TASK,
  '") + ". Export it as a CommonJS module (module.exports = { add, isPrime }). When you believe it is complete, call update_goal(status=\\"complete\\"). Completion is VERIFIED by running the acceptance test against your module; if it fails you will receive the failing output \u2014 fix /sandbox/solution.js and call update_goal again." }'
].join("");
function makeCodingGoalWorkspaceProfileTask() {
  return {
    call: "workspace/profile",
    with: {
      name: "coding-goal-eval",
      rootPath: "/sandbox",
      sandboxTemplate: '${ .trigger.sandboxTemplate // "dapr-agent" }',
      ttlSeconds: 3600,
      keepAfterRun: true,
      managedBy: "workflow-builder:demos:coding-goal-eval",
      commandTimeoutMs: 3e5,
      timeoutMs: 6e5,
      enabledTools: [
        "execute_command",
        "read_file",
        "write_file",
        "edit_file",
        "list_files",
        "mkdir",
        "file_stat"
      ],
      sandboxPolicy: {
        mode: "per-run",
        template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
        ttlSeconds: 3600,
        keepAfterRun: true
      }
    }
  };
}
function makeCodingGoalSolveTask() {
  return {
    call: "durable/run",
    with: {
      mode: "execute_direct",
      cwd: "/sandbox",
      sandboxName: "${ .workspace_profile.sandboxName }",
      workspaceRef: "${ .workspace_profile.workspaceRef }",
      sandboxPolicy: {
        mode: "per-run",
        template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
        ttlSeconds: 3600,
        keepAfterRun: true
      },
      body: {
        // Custom-loop runtime (dapr-agent-py) — uses the goal-MCP update_goal
        // path, which is evaluator-gated. agentSlug overridable per run.
        agentRef: { slug: '${ .trigger.agentSlug // "general-assistant" }' },
        prompt: CODING_GOAL_PROMPT,
        goalSpec: {
          objective: CODING_GOAL_OBJECTIVE,
          acceptanceCriteria: [
            "/sandbox/solution.js exports add(a, b) returning a + b",
            "isPrime(n) returns true for primes >= 2 and false for 0, 1, negatives, and composites",
            "the acceptance test command runs clean (exit 0, prints ALL PASS)"
          ],
          // Deterministic evidence the BFF evaluator runs before completing.
          evidence: { commands: [CODING_GOAL_EVIDENCE_COMMAND] },
          maxIterations: `\${ .trigger.maxIterations // ${CODING_GOAL_DEFAULT_MAX_ITERATIONS} }`
        },
        overrides: { cwd: "/sandbox", maxTurns: 40, timeoutMinutes: 30 }
      }
    }
  };
}
function buildCodingGoalWorkflowSpec() {
  return {
    document: {
      dsl: "1.0.0",
      namespace: "workflow-builder.demos",
      name: CODING_GOAL_WORKFLOW_ID,
      version: "1.0.0",
      title: CODING_GOAL_WORKFLOW_NAME,
      summary: CODING_GOAL_WORKFLOW_DESCRIPTION,
      "x-workflow-builder": {
        architecture: "goal-mode+evaluator-gated-completion+single-sandbox",
        notes: "Minimal evaluator-gated completion demo. The dapr-agent-py agent's update_goal(complete) is verified by the BFF running goalSpec.evidence.commands in the shared workspace; failing checks reject completion + feed back to the agent. No browser/preview/outputSync.",
        triggerInputs: {
          task: "Optional. The coding task (default: add + is_prime).",
          agentSlug: "Optional. dapr-agent-py agent slug (default general-assistant; use a strong model e.g. an OpenAI/Claude dapr agent).",
          maxIterations: "Optional. Goal-loop iteration cap (default 15)."
        },
        input: {
          fields: {
            task: {
              type: "textarea",
              label: "Coding task",
              description: "Describe the Python module the agent must implement.",
              defaultValue: CODING_GOAL_DEFAULT_TASK
            },
            agentSlug: {
              type: "text",
              label: "Agent slug (dapr-agent-py)",
              description: "Custom-loop dapr-agent-py agent to run (uses the evaluator-gated goal MCP).",
              defaultValue: CODING_GOAL_DEFAULT_AGENT_SLUG
            }
          }
        }
      }
    },
    do: [
      { workspace_profile: makeCodingGoalWorkspaceProfileTask() },
      { solve: makeCodingGoalSolveTask() }
    ],
    output: {
      as: {
        workspaceRef: "${ .workspace_profile.workspaceRef }",
        sandboxName: '${ .workspace_profile.sandboxName // "" }',
        solve: "${ .solve }"
      }
    },
    input: {
      schema: {
        document: {
          type: "object",
          required: ["task"],
          properties: {
            task: {
              type: "string",
              title: "Coding task",
              description: "The Python module the agent must implement.",
              default: CODING_GOAL_DEFAULT_TASK
            },
            agentSlug: {
              type: "string",
              title: "Agent slug",
              description: "dapr-agent-py agent slug.",
              default: CODING_GOAL_DEFAULT_AGENT_SLUG
            },
            maxIterations: {
              type: "integer",
              title: "Max goal iterations",
              default: CODING_GOAL_DEFAULT_MAX_ITERATIONS,
              minimum: 1
            },
            sandboxTemplate: {
              type: "string",
              title: "Sandbox template",
              default: "dapr-agent"
            }
          }
        },
        format: "json"
      }
    }
  };
}
function buildCodingGoalWorkflowNodes() {
  return [
    {
      id: "trigger",
      type: "trigger",
      position: { x: 80, y: 60 },
      data: {
        label: "Coding task trigger",
        description: "Receives the coding task + optional agentSlug/maxIterations."
      }
    },
    {
      id: "workspace_profile",
      type: "action",
      position: { x: 80, y: 200 },
      data: {
        label: "Provision sandbox",
        actionType: "workspace/profile",
        description: "Single dapr-agent sandbox (python/node); shared by the agent + the evaluator's evidence checks."
      }
    },
    {
      id: "solve",
      type: "action",
      position: { x: 80, y: 340 },
      data: {
        label: "Solve (goal mode, evaluator-gated)",
        actionType: "durable/run",
        description: "Agent writes solution.py under a goalSpec; update_goal(complete) is verified by the BFF running the evidence command before the goal completes."
      }
    }
  ];
}
function buildCodingGoalWorkflowEdges() {
  const ordered = ["trigger", "workspace_profile", "solve"];
  return ordered.slice(0, -1).map((source, index2) => ({
    id: `e_coding_goal_${index2 + 1}`,
    source,
    target: ordered[index2 + 1],
    type: "default"
  }));
}
function buildEvaluatorGoalWorkflowSpec(cfg) {
  return {
    document: {
      dsl: "1.0.0",
      namespace: "workflow-builder.demos",
      name: cfg.id,
      version: "1.0.0",
      title: cfg.name,
      summary: cfg.description,
      "x-workflow-builder": {
        architecture: cfg.architecture,
        notes: cfg.notes,
        triggerInputs: {
          task: "Optional. The coding task.",
          agentSlug: "Optional. dapr-agent-py agent slug (custom-loop; uses the evaluator-gated goal MCP).",
          maxIterations: "Optional. Goal-loop iteration cap."
        },
        input: {
          fields: {
            task: {
              type: "textarea",
              label: "Coding task",
              description: "Describe the module the agent must implement.",
              defaultValue: cfg.defaultTask
            },
            agentSlug: {
              type: "text",
              label: "Agent slug (dapr-agent-py)",
              description: "Custom-loop dapr-agent-py agent to run (uses the evaluator-gated goal MCP).",
              defaultValue: cfg.defaultAgentSlug
            }
          }
        }
      }
    },
    do: [
      {
        workspace_profile: {
          call: "workspace/profile",
          with: {
            name: cfg.id.slice(0, 40),
            rootPath: "/sandbox",
            sandboxTemplate: '${ .trigger.sandboxTemplate // "dapr-agent" }',
            ttlSeconds: 3600,
            keepAfterRun: true,
            managedBy: `workflow-builder:demos:${cfg.id}`,
            commandTimeoutMs: 3e5,
            timeoutMs: 6e5,
            enabledTools: [
              "execute_command",
              "read_file",
              "write_file",
              "edit_file",
              "list_files",
              "mkdir",
              "file_stat"
            ],
            sandboxPolicy: {
              mode: "per-run",
              template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
              ttlSeconds: 3600,
              keepAfterRun: true
            }
          }
        }
      },
      {
        solve: {
          call: "durable/run",
          with: {
            mode: "execute_direct",
            cwd: "/sandbox",
            sandboxName: "${ .workspace_profile.sandboxName }",
            workspaceRef: "${ .workspace_profile.workspaceRef }",
            sandboxPolicy: {
              mode: "per-run",
              template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
              ttlSeconds: 3600,
              keepAfterRun: true
            },
            body: {
              agentRef: {
                slug: `\${ .trigger.agentSlug // "${cfg.defaultAgentSlug}" }`
              },
              prompt: cfg.prompt,
              goalSpec: {
                objective: cfg.objective,
                acceptanceCriteria: cfg.acceptanceCriteria,
                evidence: { commands: cfg.evidenceCommands },
                maxIterations: `\${ .trigger.maxIterations // ${cfg.maxIterations} }`
              },
              overrides: { cwd: "/sandbox", maxTurns: 40, timeoutMinutes: 30 }
            }
          }
        }
      }
    ],
    output: {
      as: {
        workspaceRef: "${ .workspace_profile.workspaceRef }",
        sandboxName: '${ .workspace_profile.sandboxName // "" }',
        solve: "${ .solve }"
      }
    },
    input: {
      schema: {
        document: {
          type: "object",
          required: ["task"],
          properties: {
            task: {
              type: "string",
              title: "Coding task",
              default: cfg.defaultTask
            },
            agentSlug: {
              type: "string",
              title: "Agent slug",
              default: cfg.defaultAgentSlug
            },
            maxIterations: {
              type: "integer",
              title: "Max goal iterations",
              default: cfg.maxIterations,
              minimum: 1
            },
            sandboxTemplate: {
              type: "string",
              title: "Sandbox template",
              default: "dapr-agent"
            }
          }
        },
        format: "json"
      }
    }
  };
}
function buildEvaluatorGoalWorkflowNodes(cfg) {
  return [
    {
      id: "trigger",
      type: "trigger",
      position: { x: 80, y: 60 },
      data: {
        label: "Coding task trigger",
        description: "Receives the coding task + optional agentSlug/maxIterations."
      }
    },
    {
      id: "workspace_profile",
      type: "action",
      position: { x: 80, y: 200 },
      data: {
        label: "Provision sandbox",
        actionType: "workspace/profile",
        description: "Single dapr-agent sandbox; shared by the agent + the evaluator's evidence checks."
      }
    },
    {
      id: "solve",
      type: "action",
      position: { x: 80, y: 340 },
      data: {
        label: "Solve (goal mode, evaluator-gated)",
        actionType: "durable/run",
        description: "Agent works under a goalSpec; update_goal(complete) is verified by the BFF running the graded evidence commands before the goal completes."
      }
    }
  ];
}
function buildEvaluatorGoalWorkflowEdges() {
  const ordered = ["trigger", "workspace_profile", "solve"];
  return ordered.slice(0, -1).map((source, index2) => ({
    id: `e_eval_goal_${index2 + 1}`,
    source,
    target: ordered[index2 + 1],
    type: "default"
  }));
}
var ROMAN_GOAL_WORKFLOW_ID = process.env.SEED_ROMAN_GOAL_WORKFLOW_ID?.trim() || "evaluator-tdd-roman-showcase";
var ROMAN_GOAL_DEFAULT_AGENT_SLUG = process.env.SEED_ROMAN_GOAL_AGENT_SLUG?.trim() || "general-assistant";
var ROMAN_GOAL_DEFAULT_TASK = "Implement a Roman-numeral converter (intToRoman + romanToInt) in a Node.js CommonJS module.";
var ROMAN_GOAL_MAX_ITERATIONS = 20;
var ROMAN_GOAL_FUNCTIONAL_CMD = `cd /sandbox && node -e 'const s=require("./solution.js"); let f=[]; const eq=(n,g,e)=>{ if(JSON.stringify(g)!==JSON.stringify(e)) f.push(n+": expected "+JSON.stringify(e)+" got "+JSON.stringify(g)); else console.log("PASS "+n); }; eq("intToRoman(1)",s.intToRoman(1),"I"); eq("intToRoman(4)",s.intToRoman(4),"IV"); eq("intToRoman(9)",s.intToRoman(9),"IX"); eq("intToRoman(40)",s.intToRoman(40),"XL"); eq("intToRoman(90)",s.intToRoman(90),"XC"); eq("intToRoman(400)",s.intToRoman(400),"CD"); eq("intToRoman(900)",s.intToRoman(900),"CM"); eq("intToRoman(1994)",s.intToRoman(1994),"MCMXCIV"); eq("intToRoman(2023)",s.intToRoman(2023),"MMXXIII"); eq("intToRoman(3888)",s.intToRoman(3888),"MMMDCCCLXXXVIII"); eq("intToRoman(3999)",s.intToRoman(3999),"MMMCMXCIX"); eq("romanToInt(MCMXCIV)",s.romanToInt("MCMXCIV"),1994); eq("romanToInt(MMMDCCCLXXXVIII)",s.romanToInt("MMMDCCCLXXXVIII"),3888); eq("romanToInt(XLII)",s.romanToInt("XLII"),42); [1,4,9,40,90,400,900,944,1994,2023,3549,3888,3999].forEach(n=>{ const r=s.romanToInt(s.intToRoman(n)); if(r!==n) f.push("roundtrip("+n+"): got "+r); }); if(f.length){ console.error("FAILURES:\\n"+f.join("\\n")); process.exit(1); } console.log("ALL "+"PASS"); '`;
var ROMAN_GOAL_CONTRACT_CMD = `cd /sandbox && node -e 'const s=require("./solution.js"); const miss=["intToRoman","romanToInt"].filter(fn=>typeof s[fn]!=="function"); if(miss.length){ console.error("Missing exports: "+miss.join(", ")); process.exit(1);} console.log("exports OK"); '`;
var ROMAN_GOAL_OBJECTIVE = [
  '${ "Write /sandbox/solution.js (Node.js CommonJS) that satisfies: " + (.trigger.task // "',
  ROMAN_GOAL_DEFAULT_TASK,
  '") + ". Export intToRoman(n) (1..3999, correct SUBTRACTIVE forms IV, IX, XL, XC, CD, CM) and romanToInt(s) as its exact inverse. The goal is COMPLETE only when ALL graded acceptance checks pass (each exits 0). Do not weaken, delete, or special-case around the checks." }'
].join("");
var ROMAN_GOAL_PROMPT = [
  '${ "Write /sandbox/solution.js per the active goal: " + (.trigger.task // "',
  ROMAN_GOAL_DEFAULT_TASK,
  '") + ". Export it as CommonJS (module.exports = { intToRoman, romanToInt }). When you believe it is complete, call update_goal(status=\\"complete\\"). Completion is VERIFIED by running graded acceptance checks (a functional suite incl. round-trip + an export contract) against your module; if any fails you will receive the exact failing cases \u2014 fix /sandbox/solution.js and call update_goal again." }'
].join("");
function buildRomanGoalConfig() {
  return {
    id: ROMAN_GOAL_WORKFLOW_ID,
    name: "Evaluator TDD: Roman Numerals",
    description: "Multi-criterion, code-graded evaluator showcase: a dapr-agent-py agent implements a Roman-numeral converter under a goalSpec, and its self-declared completion is verified by the BFF running TWO graded evidence checks (functional suite with subtractive-notation + round-trip edge cases, and an export contract) against ground-truth workspace state before the goal completes. Demonstrates reject\u2192fix\u2192pass. No browser/preview.",
    defaultTask: ROMAN_GOAL_DEFAULT_TASK,
    defaultAgentSlug: ROMAN_GOAL_DEFAULT_AGENT_SLUG,
    maxIterations: ROMAN_GOAL_MAX_ITERATIONS,
    objective: ROMAN_GOAL_OBJECTIVE,
    prompt: ROMAN_GOAL_PROMPT,
    acceptanceCriteria: [
      "intToRoman(n) returns correct Roman numerals for 1..3999, including subtractive forms (IV, IX, XL, XC, CD, CM)",
      "romanToInt(s) is the exact inverse of intToRoman (round-trips across the full graded set)",
      "module.exports exposes intToRoman and romanToInt as functions",
      "every graded evidence check exits 0"
    ],
    evidenceCommands: [ROMAN_GOAL_FUNCTIONAL_CMD, ROMAN_GOAL_CONTRACT_CMD],
    architecture: "goal-mode+evaluator-gated-completion+multi-criterion-graded+single-sandbox",
    notes: "Two graded evidence commands (functional suite + export contract) are run by the BFF evaluator in the shared workspace; failing checks reject completion with the exact failing cases and feed back to the agent. Edge cases (subtractive notation, round-trip) make a first-attempt slip likely \u2192 visible reject\u2192fix\u2192pass. No browser/preview/outputSync."
  };
}
var PLANNED_GOAL_WORKFLOW_ID = process.env.SEED_PLANNED_GOAL_WORKFLOW_ID?.trim() || "planned-goal-showcase";
var PLANNED_GOAL_DEFAULT_AGENT_SLUG = process.env.SEED_PLANNED_GOAL_AGENT_SLUG?.trim() || "general-assistant";
var PLANNED_GOAL_DEFAULT_INTENT = "Build a working min-stack module in /sandbox/solution.js (CommonJS) with push/pop/min in O(1) and a friendly error when popping an empty stack.";
function buildPlannedGoalWorkflowSpec(cfg) {
  return {
    document: {
      dsl: "1.0.0",
      namespace: "workflow-builder.demos",
      name: cfg.id,
      version: "1.0.0",
      title: cfg.name,
      summary: cfg.description,
      "x-workflow-builder": {
        architecture: "plan-goal+approval-gate+evaluator-gated-completion+single-sandbox",
        notes: "goal/plan authors a typed goal_spec artifact from raw intent (independent planner). A native listen/wait_for_external_event approval gate (raise `goal_spec_approval` to the workflow instance, e.g. {approved:true}) gates the SOLVE agent, which runs under the planned goalSpec with the usual evaluator-gated completion.",
        triggerInputs: {
          intent: "Plain-language description of what you want built.",
          agentSlug: "Optional. dapr-agent-py agent slug for the SOLVE step."
        },
        input: {
          fields: {
            intent: {
              type: "textarea",
              label: "Intent",
              description: "Describe in plain language what the agent should accomplish; the planner authors the goal + ground-truth checks.",
              defaultValue: cfg.defaultIntent
            },
            agentSlug: {
              type: "text",
              label: "Agent slug (dapr-agent-py)",
              description: "Custom-loop dapr-agent-py agent to run the SOLVE step.",
              defaultValue: cfg.defaultAgentSlug
            }
          }
        }
      }
    },
    do: [
      {
        workspace_profile: {
          call: "workspace/profile",
          with: {
            name: cfg.id.slice(0, 40),
            rootPath: "/sandbox",
            sandboxTemplate: '${ .trigger.sandboxTemplate // "dapr-agent" }',
            ttlSeconds: 3600,
            keepAfterRun: true,
            managedBy: `workflow-builder:demos:${cfg.id}`,
            commandTimeoutMs: 3e5,
            timeoutMs: 6e5,
            enabledTools: [
              "execute_command",
              "read_file",
              "write_file",
              "edit_file",
              "list_files",
              "mkdir",
              "file_stat"
            ],
            sandboxPolicy: {
              mode: "per-run",
              template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
              ttlSeconds: 3600,
              keepAfterRun: true
            }
          }
        }
      },
      {
        plan: {
          call: "goal/plan",
          with: {
            intent: "${ .trigger.intent }",
            context: { cwd: "/sandbox", runtime: "dapr-agent-py" }
          },
          artifacts: [
            {
              kind: "goal_spec",
              slot: "primary",
              title: "Planned goal spec",
              description: "Authored by an independent planner from the raw intent; review before approving.",
              from: '${ .data.goalSpec + {rationale: (.data.rationale // ""), lint: (.data.lint // {warnings: []})} }'
            }
          ]
        }
      },
      {
        approve_goal_spec: {
          listen: { to: { one: { with: { type: "goal_spec_approval" } } } },
          timeout: { after: "PT2H" }
        }
      },
      {
        solve: {
          if: "${ (.approve_goal_spec.timedOut // false) == false and (.approve_goal_spec.approved // true) == true }",
          call: "durable/run",
          with: {
            mode: "execute_direct",
            cwd: "/sandbox",
            sandboxName: "${ .workspace_profile.sandboxName }",
            workspaceRef: "${ .workspace_profile.workspaceRef }",
            sandboxPolicy: {
              mode: "per-run",
              template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
              ttlSeconds: 3600,
              keepAfterRun: true
            },
            body: {
              agentRef: {
                slug: `\${ .trigger.agentSlug // "${cfg.defaultAgentSlug}" }`
              },
              prompt: '${ "Work in /sandbox to satisfy the active goal: " + (.plan.goalSpec.objective // "") + ". When you believe it is complete, call update_goal(status=\\"complete\\"). Completion is VERIFIED by running the graded evidence checks against your work; if any fail you will receive the failing cases \u2014 fix and call update_goal again." }',
              goalSpec: "${ .plan.goalSpec }",
              overrides: { cwd: "/sandbox", maxTurns: 40, timeoutMinutes: 30 }
            }
          }
        }
      }
    ],
    output: {
      as: {
        workspaceRef: "${ .workspace_profile.workspaceRef }",
        sandboxName: '${ .workspace_profile.sandboxName // "" }',
        goalSpec: "${ .plan.goalSpec }",
        solve: "${ .solve }"
      }
    },
    input: {
      schema: {
        document: {
          type: "object",
          required: ["intent"],
          properties: {
            intent: {
              type: "string",
              title: "Intent",
              default: cfg.defaultIntent
            },
            agentSlug: {
              type: "string",
              title: "Agent slug",
              default: cfg.defaultAgentSlug
            },
            sandboxTemplate: {
              type: "string",
              title: "Sandbox template",
              default: "dapr-agent"
            }
          }
        },
        format: "json"
      }
    }
  };
}
function buildPlannedGoalWorkflowNodes(cfg) {
  return [
    {
      id: "trigger",
      type: "trigger",
      position: { x: 80, y: 60 },
      data: {
        label: "Intent trigger",
        description: "Receives the plain-language intent + optional agentSlug."
      }
    },
    {
      id: "workspace_profile",
      type: "action",
      position: { x: 80, y: 200 },
      data: {
        label: "Provision sandbox",
        actionType: "workspace/profile",
        description: "Single dapr-agent sandbox shared by the SOLVE agent + evidence checks."
      }
    },
    {
      id: "plan",
      type: "action",
      position: { x: 80, y: 340 },
      data: {
        label: "Plan goal (independent planner)",
        actionType: "goal/plan",
        description: "Turns the raw intent into a typed goal_spec artifact (objective + criteria + ground-truth evidence), authored isolated from the doer."
      }
    },
    {
      id: "approve_goal_spec",
      type: "approval-gate",
      position: { x: 80, y: 480 },
      data: {
        label: "Approve goal spec",
        description: "Native approval gate (wait_for_external_event). Raise `goal_spec_approval` {approved:true} to proceed; times out after 2h."
      }
    },
    {
      id: "solve",
      type: "action",
      position: { x: 80, y: 620 },
      data: {
        label: "Solve (goal mode, evaluator-gated)",
        actionType: "durable/run",
        description: "Agent works under the approved goalSpec; update_goal(complete) is verified by the BFF running the graded evidence before the goal completes."
      }
    }
  ];
}
function buildPlannedGoalWorkflowEdges() {
  const ordered = ["trigger", "workspace_profile", "plan", "approve_goal_spec", "solve"];
  return ordered.slice(0, -1).map((source, index2) => ({
    id: `e_planned_goal_${index2 + 1}`,
    source,
    target: ordered[index2 + 1],
    type: "default"
  }));
}
function buildPlannedGoalConfig() {
  return {
    id: PLANNED_GOAL_WORKFLOW_ID,
    name: "Planned Goal: Intent \u2192 Plan \u2192 Approve \u2192 Solve",
    description: "Goal-authoring showcase: a deterministic goal/plan node turns raw intent into a typed goal_spec artifact (independent planner), a native approval gate lets a human approve it, then a dapr-agent-py agent solves under the approved goalSpec with evaluator-gated completion. Demonstrates the PLAN\u2192SOLVE pre-step from docs/goal-authoring-and-claude-alignment.md.",
    defaultIntent: PLANNED_GOAL_DEFAULT_INTENT,
    defaultAgentSlug: PLANNED_GOAL_DEFAULT_AGENT_SLUG
  };
}
var PLANNED_GOAL_AGENT_WORKFLOW_ID = process.env.SEED_PLANNED_GOAL_AGENT_WORKFLOW_ID?.trim() || "planned-goal-agent-showcase";
var PLANNED_GOAL_AGENT_DEFAULT_INTENT = "Build /sandbox/solution.js (CommonJS) exporting evaluate(expr): a string arithmetic expression evaluator supporting + - * / , parentheses, correct operator precedence, unary minus, integer and decimal numbers, and arbitrary whitespace. Throw a clear Error on invalid input. Do NOT use eval() or Function().";
var PLANNED_GOAL_AGENT_PLANNER_INSTRUCTIONS = [
  "You are an INDEPENDENT GOAL PLANNER. Do NOT implement the user's task as a deliverable \u2014 your job is to produce a precise, TESTABLE goal spec for ANOTHER agent to implement, and to PROVE your acceptance checks actually work before handing them off. You are in an isolated /sandbox that will be DISCARDED after you finish.",
  "",
  "Do this:",
  "1. Draft: an `objective` (one measurable end state), 3-6 `acceptanceCriteria` (specific, measurable, INCLUDING edge cases), and `evidence.commands` \u2014 shell commands that verify the criteria against ground truth.",
  "   - Each command MUST be self-contained and reference the implementation the SOLVER will write at /sandbox/solution.js. Shape: cd /sandbox && node -e '...assert...'.",
  "   - Use SINGLE-quoted node -e scripts. Do NOT use backticks, $(...), or ${...} anywhere in a command (the shell mangles them \u2014 this is the #1 cause of broken checks).",
  "   - exit 0 ONLY when the criterion is met; on failure print actual-vs-expected.",
  "   - Do NOT leak the answer: test BEHAVIOR; never echo/grep a literal expected value you spelled out.",
  "2. Write a CORRECT reference implementation to /sandbox/solution.js.",
  "3. VALIDATE every command by RUNNING it: against the reference each MUST exit 0; then `rm -f /sandbox/solution.js` and run each again \u2014 each MUST exit non-zero. If a command errors (shell parse), always-passes, or always-fails, FIX it and re-run until ALL discriminate correctly.",
  "4. Clean up: ensure /sandbox/solution.js is removed so nothing leaks.",
  "5. Output your FINAL message as a SINGLE fenced ```json code block and NOTHING else, with keys: objective (string), acceptanceCriteria (string[]), evidence (object with key commands: string[]), maxIterations (number, ~15), rationale (string that notes you validated each check passes on a correct impl and fails on an empty one)."
].join("\n");
function buildPlannedGoalAgentWorkflowSpec(cfg) {
  const planPrompt = "${ " + JSON.stringify(
    PLANNED_GOAL_AGENT_PLANNER_INSTRUCTIONS + "\n\nIntent to plan a goal for:\n"
  ) + " + .trigger.intent }";
  const workspaceProfile = (name, keep) => ({
    call: "workspace/profile",
    with: {
      name: name.slice(0, 40),
      rootPath: "/sandbox",
      sandboxTemplate: '${ .trigger.sandboxTemplate // "dapr-agent" }',
      ttlSeconds: 3600,
      keepAfterRun: keep,
      managedBy: `workflow-builder:demos:${cfg.id}`,
      commandTimeoutMs: 3e5,
      timeoutMs: 6e5,
      enabledTools: [
        "execute_command",
        "read_file",
        "write_file",
        "edit_file",
        "list_files",
        "mkdir",
        "file_stat"
      ],
      sandboxPolicy: {
        mode: "per-run",
        template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
        ttlSeconds: 3600,
        keepAfterRun: keep
      }
    }
  });
  return {
    document: {
      dsl: "1.0.0",
      namespace: "workflow-builder.demos",
      name: cfg.id,
      version: "1.0.0",
      title: cfg.name,
      summary: cfg.description,
      "x-workflow-builder": {
        architecture: "planner-agent+validate-by-execution+approval-gate+evaluator-gated-completion+isolated-sandboxes",
        notes: "PLAN is a durable/run AGENT in its OWN throwaway sandbox: drafts the goalSpec, writes a reference solution, runs each evidence command against it (must pass) and against an empty workspace (must fail), repairs, then emits the validated spec as JSON. A goal/plan fromText node extracts it. The planner sandbox is discarded \u2014 its reference solution never reaches SOLVE; the evaluator runs evidence only in the retained SOLVE sandbox. Raise `goal_spec_approval` {approved:true} to gate SOLVE.",
        triggerInputs: {
          intent: "Plain-language description of what you want built.",
          agentSlug: "Optional. dapr-agent-py agent slug for plan + solve."
        },
        input: {
          fields: {
            intent: {
              type: "textarea",
              label: "Intent",
              description: "Describe the task; the PLANNER AGENT authors AND validates the goal + ground-truth checks before the solver runs.",
              defaultValue: cfg.defaultIntent
            },
            agentSlug: {
              type: "text",
              label: "Agent slug (dapr-agent-py)",
              description: "dapr-agent-py agent used for both the planner and solver runs.",
              defaultValue: cfg.defaultAgentSlug
            }
          }
        }
      }
    },
    do: [
      { plan_workspace: workspaceProfile(`${cfg.id}-plan`, false) },
      {
        plan_agent: {
          call: "durable/run",
          with: {
            mode: "execute_direct",
            cwd: "/sandbox",
            sandboxName: "${ .plan_workspace.sandboxName }",
            workspaceRef: "${ .plan_workspace.workspaceRef }",
            sandboxPolicy: {
              mode: "per-run",
              template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
              ttlSeconds: 3600,
              keepAfterRun: false
            },
            body: {
              agentRef: {
                slug: `\${ .trigger.agentSlug // "${cfg.defaultAgentSlug}" }`
              },
              prompt: planPrompt,
              overrides: { cwd: "/sandbox", maxTurns: 40, timeoutMinutes: 30 }
            }
          }
        }
      },
      {
        plan_finalize: {
          call: "goal/plan",
          with: {
            fromText: '${ .plan_agent.content // .plan_agent.data.content // "" }'
          },
          artifacts: [
            {
              kind: "goal_spec",
              slot: "primary",
              title: "Validated goal spec (planner agent)",
              description: "Authored AND validated by an independent planner agent \u2014 it wrote a reference solution and ran each evidence check against it (pass) and against an empty workspace (fail) before emitting this spec.",
              from: '${ .data.goalSpec + {rationale: (.data.rationale // ""), lint: (.data.lint // {warnings: []})} }'
            }
          ]
        }
      },
      {
        approve_goal_spec: {
          listen: { to: { one: { with: { type: "goal_spec_approval" } } } },
          timeout: { after: "PT2H" }
        }
      },
      { solve_workspace: workspaceProfile(`${cfg.id}-solve`, true) },
      {
        solve: {
          if: "${ (.approve_goal_spec.timedOut // false) == false and (.approve_goal_spec.approved // true) == true }",
          call: "durable/run",
          with: {
            mode: "execute_direct",
            cwd: "/sandbox",
            sandboxName: "${ .solve_workspace.sandboxName }",
            workspaceRef: "${ .solve_workspace.workspaceRef }",
            sandboxPolicy: {
              mode: "per-run",
              template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
              ttlSeconds: 3600,
              keepAfterRun: true
            },
            body: {
              agentRef: {
                slug: `\${ .trigger.agentSlug // "${cfg.defaultAgentSlug}" }`
              },
              prompt: '${ "Work in /sandbox to satisfy the active goal: " + (.plan_finalize.goalSpec.objective // "") + ". When you believe it is complete, call update_goal(status=\\"complete\\"). Completion is VERIFIED by running the graded evidence checks against your work; if any fail you will receive the failing cases \u2014 fix and call update_goal again." }',
              goalSpec: "${ .plan_finalize.goalSpec }",
              overrides: { cwd: "/sandbox", maxTurns: 40, timeoutMinutes: 30 }
            }
          }
        }
      }
    ],
    output: {
      as: {
        goalSpec: "${ .plan_finalize.goalSpec }",
        sandboxName: '${ .solve_workspace.sandboxName // "" }',
        solve: "${ .solve }"
      }
    },
    input: {
      schema: {
        document: {
          type: "object",
          required: ["intent"],
          properties: {
            intent: { type: "string", title: "Intent", default: cfg.defaultIntent },
            agentSlug: {
              type: "string",
              title: "Agent slug",
              default: cfg.defaultAgentSlug
            },
            sandboxTemplate: {
              type: "string",
              title: "Sandbox template",
              default: "dapr-agent"
            }
          }
        },
        format: "json"
      }
    }
  };
}
function buildPlannedGoalAgentWorkflowNodes() {
  const meta = [
    ["trigger", "trigger", "", "Intent trigger \u2014 plain-language task + optional agentSlug."],
    [
      "plan_workspace",
      "action",
      "workspace/profile",
      "Throwaway planner sandbox (keepAfterRun:false) \u2014 discarded; isolated from solve."
    ],
    [
      "plan_agent",
      "action",
      "durable/run",
      "Planner AGENT: drafts the goalSpec, writes a reference solution, runs each evidence check vs it (pass) and vs empty (fail), repairs, emits validated JSON."
    ],
    [
      "plan_finalize",
      "action",
      "goal/plan",
      "Extracts + normalizes the planner agent's JSON into a typed goal_spec artifact (fromText mode; no LLM call)."
    ],
    [
      "approve_goal_spec",
      "approval-gate",
      "",
      "Native approval gate. Raise `goal_spec_approval` {approved:true} to proceed."
    ],
    [
      "solve_workspace",
      "action",
      "workspace/profile",
      "Retained SOLVE sandbox (keepAfterRun:true) \u2014 where the evaluator runs evidence."
    ],
    [
      "solve",
      "action",
      "durable/run",
      "Solver agent works under the validated goalSpec; evaluator-gated completion."
    ]
  ];
  return meta.map(([id, type, actionType, description], i) => ({
    id,
    type,
    position: { x: 80, y: 60 + i * 130 },
    data: {
      label: id,
      ...actionType ? { actionType } : {},
      description
    }
  }));
}
function buildPlannedGoalAgentWorkflowEdges() {
  const ordered = [
    "trigger",
    "plan_workspace",
    "plan_agent",
    "plan_finalize",
    "approve_goal_spec",
    "solve_workspace",
    "solve"
  ];
  return ordered.slice(0, -1).map((source, index2) => ({
    id: `e_planned_goal_agent_${index2 + 1}`,
    source,
    target: ordered[index2 + 1],
    type: "default"
  }));
}
function buildPlannedGoalAgentConfig() {
  return {
    id: PLANNED_GOAL_AGENT_WORKFLOW_ID,
    name: "Planned Goal (Agent Planner): Validate-by-Execution \u2192 Approve \u2192 Solve",
    description: "Planner-agent showcase: the PLAN phase is a durable/run agent that drafts the goalSpec AND proves it \u2014 writing a reference solution and running each evidence check against it (pass) and an empty workspace (fail) in an isolated, discarded sandbox \u2014 before a native approval gate and the evaluator-gated SOLVE agent. The planner's reference solution never reaches solve. Companion to planned-goal-showcase (deterministic planner). See docs/goal-authoring-and-claude-alignment.md.",
    defaultIntent: PLANNED_GOAL_AGENT_DEFAULT_INTENT,
    defaultAgentSlug: PLANNED_GOAL_DEFAULT_AGENT_SLUG
  };
}
async function upsertRawWorkflow(params) {
  const visibility = params.visibility ?? "private";
  const engineType = params.engineType ?? "dapr";
  const existing = await params.db.query.workflows.findFirst({
    where: eq(workflows.id, params.workflowId)
  });
  if (!existing) {
    await params.db.insert(workflows).values({
      id: params.workflowId,
      name: params.name,
      description: params.description,
      userId: params.userId,
      projectId: params.projectId,
      nodes: params.nodes,
      edges: params.edges,
      specVersion: "1.0.0",
      spec: params.spec,
      visibility,
      engineType
    });
    console.log(
      `[seed-workflows] Created workflow ${params.workflowId} for user ${params.userId}`
    );
    return;
  }
  if (existing.userId !== params.userId || (existing.projectId ?? null) !== params.projectId) {
    throw new Error(
      `Workflow ${params.workflowId} already exists for user ${existing.userId} project ${existing.projectId ?? "null"}; set a targeted seed owner or move the existing workflow first.`
    );
  }
  await params.db.update(workflows).set({
    name: params.name,
    description: params.description,
    userId: params.userId,
    projectId: params.projectId,
    nodes: params.nodes,
    edges: params.edges,
    specVersion: "1.0.0",
    spec: params.spec,
    visibility,
    engineType,
    updatedAt: /* @__PURE__ */ new Date()
  }).where(eq(workflows.id, params.workflowId));
  console.log(
    `[seed-workflows] Reconciled workflow ${params.workflowId} for user ${params.userId}`
  );
}
async function upsertPreviewHmrGateCodeFunction(params) {
  const now = /* @__PURE__ */ new Date();
  const sourceHash = crypto4.createHash("sha256").update(PREVIEW_HMR_GATE_SOURCE).digest("hex");
  const semanticModel = {
    params: [
      {
        name: "config",
        required: true,
        type: { kind: "object" }
      }
    ]
  };
  const metadata = {
    schema: null,
    return_type: null,
    imports: [],
    diagnostics: [],
    capabilities: {}
  };
  const [existing] = await params.db.select({ id: codeFunctions.id }).from(codeFunctions).where(eq(codeFunctions.slug, PREVIEW_HMR_GATE_SLUG)).limit(1);
  if (!existing) {
    await params.db.insert(codeFunctions).values({
      id: PREVIEW_HMR_GATE_FUNCTION_ID,
      name: "Preview HMR Gate",
      slug: PREVIEW_HMR_GATE_SLUG,
      description: "Deterministic preview verifier for exported live-sync source generation and route health.",
      version: PREVIEW_HMR_GATE_VERSION,
      language: "python",
      entrypoint: "main",
      path: null,
      source: PREVIEW_HMR_GATE_SOURCE,
      supportingFiles: {},
      sourceHash,
      semanticModel,
      inputSchema: null,
      returnType: metadata.return_type,
      imports: metadata.imports,
      diagnostics: metadata.diagnostics,
      capabilities: metadata.capabilities,
      role: "function",
      compositionGraph: null,
      latestPublishedVersion: PREVIEW_HMR_GATE_VERSION,
      lastPublishedAt: now,
      isEnabled: true,
      createdBy: params.userId
    });
  } else {
    await params.db.update(codeFunctions).set({
      name: "Preview HMR Gate",
      description: "Deterministic preview verifier for exported live-sync source generation and route health.",
      version: PREVIEW_HMR_GATE_VERSION,
      language: "python",
      entrypoint: "main",
      path: null,
      source: PREVIEW_HMR_GATE_SOURCE,
      supportingFiles: {},
      sourceHash,
      semanticModel,
      inputSchema: null,
      returnType: metadata.return_type,
      imports: metadata.imports,
      diagnostics: metadata.diagnostics,
      capabilities: metadata.capabilities,
      role: "function",
      compositionGraph: null,
      latestPublishedVersion: PREVIEW_HMR_GATE_VERSION,
      lastPublishedAt: now,
      isEnabled: true,
      updatedAt: now,
      createdBy: params.userId
    }).where(eq(codeFunctions.id, existing.id));
  }
  await params.db.insert(codeFunctionRevisions).values({
    id: `${existing?.id ?? PREVIEW_HMR_GATE_FUNCTION_ID}_v1`,
    codeFunctionId: existing?.id ?? PREVIEW_HMR_GATE_FUNCTION_ID,
    version: PREVIEW_HMR_GATE_VERSION,
    name: "Preview HMR Gate",
    slug: PREVIEW_HMR_GATE_SLUG,
    description: "Deterministic preview verifier for exported live-sync source generation and route health.",
    language: "python",
    entrypoint: "main",
    path: null,
    source: PREVIEW_HMR_GATE_SOURCE,
    supportingFiles: {},
    sourceHash,
    semanticModel,
    inputSchema: null,
    returnType: metadata.return_type,
    imports: metadata.imports,
    diagnostics: metadata.diagnostics,
    capabilities: metadata.capabilities,
    role: "function",
    compositionGraph: null,
    publishedAt: now,
    createdBy: params.userId
  }).onConflictDoUpdate({
    target: [
      codeFunctionRevisions.codeFunctionId,
      codeFunctionRevisions.version
    ],
    set: {
      name: "Preview HMR Gate",
      slug: PREVIEW_HMR_GATE_SLUG,
      description: "Deterministic preview verifier for exported live-sync source generation and route health.",
      language: "python",
      entrypoint: "main",
      path: null,
      source: PREVIEW_HMR_GATE_SOURCE,
      supportingFiles: {},
      sourceHash,
      semanticModel,
      inputSchema: null,
      returnType: metadata.return_type,
      imports: metadata.imports,
      diagnostics: metadata.diagnostics,
      capabilities: metadata.capabilities,
      role: "function",
      compositionGraph: null,
      publishedAt: now,
      createdBy: params.userId
    }
  });
  console.log(
    `[seed-workflows] Reconciled code function ${PREVIEW_HMR_GATE_SLUG}@${PREVIEW_HMR_GATE_VERSION}`
  );
}
function hostPreviewLifecycleDefinition() {
  const script = fs2.readFileSync(
    path.resolve(
      process.cwd(),
      "scripts/fixtures/dynamic-scripts/preview-development-lifecycle.js"
    ),
    "utf8"
  );
  const description = "Provision an isolated app-live preview from the physical dev cluster, start its pinned automated GAN-style UI development workflow with the submitted intent, verify its draft PR receipt, and complete guarded teardown.";
  return {
    script,
    description,
    meta: {
      name: "preview-development-lifecycle",
      description,
      phases: [
        { title: "Provision" },
        { title: "Start development" },
        { title: "Observe" },
        { title: "Finalize" }
      ],
      launch: { surface: "dev-environment", target: "control-plane" },
      input: {
        type: "object",
        required: ["intent", "environmentName"],
        additionalProperties: false,
        properties: {
          intent: {
            type: "string",
            title: "Development task",
            minLength: 1,
            maxLength: 12e3,
            description: "The initial task sent to the preview-local automated UI development workflow."
          },
          environmentName: {
            type: "string",
            title: "Preview environment name",
            pattern: "^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$"
          },
          services: {
            type: "array",
            title: "Microservices to develop",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string" },
            default: ["workflow-builder"]
          },
          ttlHours: {
            type: "integer",
            title: "Preview lifetime in hours",
            minimum: 2,
            maximum: 24,
            default: 8
          },
          retainAfterCompletion: {
            type: "boolean",
            title: "Retain environment after completion",
            default: false
          },
          retainOnFailure: {
            type: "boolean",
            title: "Retain environment after failure",
            default: false
          }
        }
      }
    }
  };
}
function previewUiDevelopmentGanDefinition() {
  const script = fs2.readFileSync(
    path.resolve(
      process.cwd(),
      "scripts/fixtures/dynamic-scripts/preview-ui-development-gan.js"
    ),
    "utf8"
  );
  const description = "Preview-local automated UI development loop for workflow-builder: enter the existing app-live preview's live-sync mode, use a deterministic dashboard contract plus the GLM JuiceFS Dapr agent to implement a dashboard UI change, verify the HMR-served app, snapshot the exact live-sync generation, and open a draft PR.";
  return {
    script,
    description,
    meta: {
      name: "preview-ui-development-gan",
      description,
      phases: [
        { title: "Dev mode" },
        { title: "Plan" },
        { title: "Generate" },
        { title: "Verify" },
        { title: "Promote" }
      ],
      launch: { surface: "dev-environment" },
      estimatedAgentCalls: 2,
      input: {
        type: "object",
        required: ["intent"],
        additionalProperties: false,
        properties: {
          intent: {
            type: "string",
            title: "Dashboard development task",
            minLength: 1,
            maxLength: 12e3
          },
          service: { type: "string", default: "workflow-builder" },
          services: {
            type: "array",
            items: { type: "string" },
            default: ["workflow-builder"]
          },
          targetRoutes: {
            type: "array",
            items: { type: "string" },
            default: ["/dashboard"]
          },
          maxIterations: { type: "integer", minimum: 1, maximum: 3, default: 2 },
          agentSlug: {
            type: "string",
            default: "glm-juicefs-builder-agent"
          },
          keepPreview: {
            anyOf: [
              { type: "boolean" },
              { type: "string", enum: ["true", "false"] }
            ],
            default: "true"
          },
          mode: {
            type: "string",
            enum: ["preview-native"]
          },
          previewOrigin: {
            type: "string"
          },
          sourceRevision: {
            type: "string",
            pattern: "^[0-9a-f]{40}$"
          },
          __previewDevelopment: {
            type: "object",
            additionalProperties: true
          }
        }
      }
    }
  };
}
async function seedHostPreviewLifecycleForAdminProjects(params) {
  const owners = await params.db.select({ projectId: projects.id, userId: users.id }).from(users).innerJoin(projects, eq(projects.ownerId, users.id)).where(and(eq(users.platformRole, "ADMIN"), eq(users.status, "ACTIVE")));
  const definition = hostPreviewLifecycleDefinition();
  for (const installation of planProjectSystemWorkflowInstallations({
    baseWorkflowId: "preview-development-lifecycle",
    canonicalProjectId: params.canonicalProjectId,
    owners
  })) {
    await upsertRawWorkflow({
      db: params.db,
      workflowId: installation.workflowId,
      name: "Preview development lifecycle",
      description: definition.description,
      userId: installation.userId,
      projectId: installation.projectId,
      spec: {
        engine: "dynamic-script",
        script: definition.script,
        meta: definition.meta
      },
      nodes: [],
      edges: [],
      visibility: "public",
      engineType: "dynamic-script"
    });
  }
}
async function upsertWorkflow(params) {
  const resolved = resolveCanonicalWorkflowSpec({
    name: params.name,
    description: params.description,
    nodes: params.nodes,
    edges: params.edges
  });
  const visibility = params.visibility ?? "private";
  const existing = await params.db.query.workflows.findFirst({
    where: eq(workflows.id, params.workflowId)
  });
  if (!existing) {
    await params.db.insert(workflows).values({
      id: params.workflowId,
      name: params.name,
      description: params.description,
      userId: params.userId,
      projectId: params.projectId,
      nodes: params.nodes,
      edges: params.edges,
      specVersion: resolved.specVersion,
      spec: resolved.spec,
      visibility,
      engineType: "dapr"
    });
    console.log(
      `[seed-workflows] Created workflow ${params.workflowId} for user ${params.userId}`
    );
    return;
  }
  if (existing.userId !== params.userId || (existing.projectId ?? null) !== params.projectId) {
    throw new Error(
      `Workflow ${params.workflowId} already exists for user ${existing.userId} project ${existing.projectId ?? "null"}; set a targeted seed owner or move the existing workflow first.`
    );
  }
  await params.db.update(workflows).set({
    name: params.name,
    description: params.description,
    userId: params.userId,
    projectId: params.projectId,
    nodes: params.nodes,
    edges: params.edges,
    specVersion: resolved.specVersion,
    spec: resolved.spec,
    visibility,
    engineType: "dapr",
    updatedAt: /* @__PURE__ */ new Date()
  }).where(eq(workflows.id, params.workflowId));
  console.log(
    `[seed-workflows] Reconciled workflow ${params.workflowId} for user ${params.userId}`
  );
}
function buildGeneratorCriticGraph(spec) {
  const doArr = Array.isArray(spec.do) ? spec.do : [];
  const taskNames = doArr.map((t) => Object.keys(t)[0]);
  const ids = ["trigger", ...taskNames];
  const nodes = [
    {
      id: "trigger",
      type: "trigger",
      position: { x: 80, y: 40 },
      data: {
        label: "Manual trigger",
        description: "Provide the intent (and optional agentSlug).",
        // Materialize the SW 1.0 trigger-input schema onto the START node so the
        // canvas run dialog renders editable parameter fields (intent/targetRoute/
        // agents). The execute-dialog reads
        // `startNode.data.taskConfig.input.schema.document`; without this the inputs
        // live only in `spec.input` and can't be changed from the UI.
        ...spec.input ? { taskConfig: { input: spec.input } } : {}
      }
    },
    ...taskNames.map((name, i) => {
      const node = doArr[i][name] || {};
      const actionType = node.call || (node.for ? "for" : node.set ? "set" : node.listen ? "listen" : "task");
      return {
        id: name,
        type: "action",
        position: { x: 80, y: 180 + i * 140 },
        data: { label: name, actionType, description: "" }
      };
    })
  ];
  const edges = ids.slice(0, -1).map((source, i) => ({
    id: `e_gc_${i + 1}`,
    source,
    target: ids[i + 1],
    type: "default"
  }));
  return { nodes, edges };
}
async function ensureShowcaseAgent(sqlClient, userId, projectId) {
  const slug = "evaluator-critic-agent";
  const existing = await sqlClient`
		select id, current_version_id from agents where slug = ${slug} limit 1`;
  if (existing.length && existing[0].current_version_id) return slug;
  const agentId = existing.length ? existing[0].id : generateId();
  const modelSpec = process.env.SEED_SHOWCASE_AGENT_MODEL?.trim() || "deepseek-v4-pro";
  const config = {
    runtime: "dapr-agent-py",
    modelSpec,
    maxTurns: 50,
    timeoutMinutes: 30,
    memory: { backend: "dapr_state" },
    skills: [],
    tools: [],
    mcpServers: []
  };
  const configHash = crypto4.createHash("sha256").update(JSON.stringify(config)).digest("hex");
  const versionId = generateId();
  if (!existing.length) {
    await sqlClient`
			insert into agents (id, name, description, agent_type, max_turns, timeout_minutes, project_id, user_id, registry_status, slug, runtime)
			values (${agentId}, ${"Evaluator/Critic Agent"},
				${"Shared dapr-agent-py agent for the generator/critic showcase loops; per-session dispatch (no pool pin)."},
				${"general"}, ${50}, ${30}, ${projectId}, ${userId}, ${"registered"}, ${slug}, ${"dapr-agent-py"})`;
  } else {
    await sqlClient`update agents set registry_status = ${"registered"}, runtime = ${"dapr-agent-py"} where id = ${agentId}`;
  }
  await sqlClient`
		insert into agent_versions (id, agent_id, version, config, config_hash)
		values (${versionId}, ${agentId}, ${1}, ${JSON.stringify(config)}::jsonb, ${configHash})`;
  await sqlClient`update agents set current_version_id = ${versionId} where id = ${agentId}`;
  console.log(`[seed-workflows] Ensured showcase agent "${slug}"`);
  return slug;
}
async function ensureCliShowcaseAgentFor(sqlClient, userId, projectId, opts) {
  const { slug, runtime, name, description } = opts;
  const config = {
    runtime,
    ...opts.modelSpec ? { modelSpec: opts.modelSpec } : {},
    ...opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {},
    ...opts.contextWindowTokens ? { contextWindowTokens: opts.contextWindowTokens } : {},
    ...opts.effort ? { effort: opts.effort } : {},
    ...opts.instructions ? { instructions: opts.instructions } : {},
    maxTurns: 50,
    timeoutMinutes: 30,
    skills: [],
    tools: [],
    mcpServers: opts.mcpServers ?? []
  };
  const configHash = crypto4.createHash("sha256").update(JSON.stringify(config)).digest("hex");
  const existing = await sqlClient`
		select id, current_version_id from agents where slug = ${slug} limit 1`;
  if (existing.length && existing[0].current_version_id) {
    const agentId2 = existing[0].id;
    await sqlClient`
			update agents
			set name = ${name}, description = ${description}, runtime = ${runtime},
				registry_status = ${"registered"}, instructions = ${opts.instructions ?? null}
			where id = ${agentId2}`;
    const cur = await sqlClient`
			select config_hash from agent_versions where id = ${existing[0].current_version_id} limit 1`;
    if (cur.length && cur[0].config_hash === configHash) return slug;
    const maxV = await sqlClient`
			select coalesce(max(version), 0)::int as v from agent_versions where agent_id = ${agentId2}`;
    const nextVersion = (maxV[0]?.v ?? 0) + 1;
    const newVersionId = generateId();
    await sqlClient`
			insert into agent_versions (id, agent_id, version, config, config_hash)
			values (${newVersionId}, ${agentId2}, ${nextVersion}, ${JSON.stringify(config)}::jsonb, ${configHash})`;
    await sqlClient`update agents set current_version_id = ${newVersionId} where id = ${agentId2}`;
    console.log(
      `[seed-workflows] Updated showcase agent "${slug}" -> v${nextVersion} (runtime=${runtime}, modelSpec=${opts.modelSpec ?? "n/a"})`
    );
    return slug;
  }
  const agentId = existing.length ? existing[0].id : generateId();
  const versionId = generateId();
  if (!existing.length) {
    await sqlClient`
			insert into agents (id, name, description, agent_type, max_turns, timeout_minutes, project_id, user_id, registry_status, slug, runtime, instructions)
			values (${agentId}, ${name},
				${description},
				${"general"}, ${50}, ${30}, ${projectId}, ${userId}, ${"registered"}, ${slug}, ${runtime}, ${opts.instructions ?? null})`;
  } else {
    await sqlClient`
			update agents
			set name = ${name}, description = ${description}, runtime = ${runtime},
				registry_status = ${"registered"}, instructions = ${opts.instructions ?? null}
			where id = ${agentId}`;
  }
  await sqlClient`
		insert into agent_versions (id, agent_id, version, config, config_hash)
		values (${versionId}, ${agentId}, ${1}, ${JSON.stringify(config)}::jsonb, ${configHash})`;
  await sqlClient`update agents set current_version_id = ${versionId} where id = ${agentId}`;
  console.log(`[seed-workflows] Ensured CLI showcase agent "${slug}" (runtime=${runtime})`);
  return slug;
}
async function ensureCliShowcaseAgent(sqlClient, userId, projectId) {
  return ensureCliShowcaseAgentFor(sqlClient, userId, projectId, {
    slug: "cli-evaluator-critic-agent",
    runtime: "claude-code-cli",
    name: "CLI Evaluator/Critic Agent",
    description: "Shared claude-code-cli agent for the CLI generator/critic showcase loop; per-session dispatch, shared JuiceFS workspace at /sandbox/work."
  });
}
async function seedGeneratorCriticShowcases(params) {
  await ensureShowcaseAgent(params.sqlClient, params.userId, params.projectId);
  await ensureCliShowcaseAgent(params.sqlClient, params.userId, params.projectId);
  await ensureCliShowcaseAgentFor(params.sqlClient, params.userId, params.projectId, {
    slug: "dapr-juicefs-evaluator-critic-agent",
    runtime: "dapr-agent-py-juicefs",
    name: "Dapr (JuiceFS) Evaluator/Critic Agent",
    description: "Pilot dapr-agent-py agent on the juicefs-shared backend: runs file/command tools pod-locally against the per-execution JuiceFS /sandbox/work (no openshell RPC), sharing the workspace with the cliWorkspace deterministic gate.",
    modelSpec: process.env.SEED_SHOWCASE_AGENT_MODEL?.trim() || "deepseek-v4-pro"
  });
  await ensureCliShowcaseAgentFor(params.sqlClient, params.userId, params.projectId, {
    slug: "dapr-juicefs-dev-agent",
    runtime: "dapr-agent-py-juicefs",
    name: "Dapr JuiceFS Dev Agent",
    description: "Interactive PreviewEnvironment developer that edits the per-execution JuiceFS workspace, runs the service-aware sync helper, and validates the isolated live system without a host CLI credential.",
    modelSpec: "deepseek-v4-pro"
  });
  await ensureCliShowcaseAgentFor(params.sqlClient, params.userId, params.projectId, {
    slug: "glm-juicefs-builder-agent",
    runtime: "dapr-agent-py-juicefs",
    name: "Kimi K3 (JuiceFS) Builder Agent",
    description: "Kimi K3 builder on the juicefs-shared backend: plans + builds the dashboard pod-locally against the per-execution JuiceFS /sandbox/work, sharing it with the deterministic gate and the Playwright visual critic.",
    modelSpec: "kimi/kimi-k3",
    reasoningEffort: "max",
    contextWindowTokens: 1048576
  });
  const PLAYWRIGHT_CRITIC_MCP = [
    {
      server_name: "playwright",
      displayName: "Playwright",
      transport: "streamable_http",
      url: "http://127.0.0.1:8002/internal/pw-proxy/mcp"
    }
  ];
  await ensureCliShowcaseAgentFor(params.sqlClient, params.userId, params.projectId, {
    slug: "cli-playwright-critic-agent",
    runtime: "claude-code-cli",
    name: "CLI Playwright Critic Agent",
    description: "claude-code-cli design critic with the Playwright MCP server; drives Chromium in-pod to inspect the rendered app and judge it against a design rubric.",
    mcpServers: PLAYWRIGHT_CRITIC_MCP
  });
  await ensureCliShowcaseAgentFor(params.sqlClient, params.userId, params.projectId, {
    slug: "cli-dev-agent",
    runtime: "claude-code-cli",
    name: "CLI Dev Agent",
    description: "claude-code-cli interactive developer agent for microservice dev-sessions: edits the cloned repo in /sandbox/work, runs ./sync.sh to live-sync the per-run dev preview, and inspects the result (Playwright MCP).",
    mcpServers: PLAYWRIGHT_CRITIC_MCP
  });
  await ensureCliShowcaseAgentFor(params.sqlClient, params.userId, params.projectId, {
    slug: "codex-cli-evaluator-critic-agent",
    runtime: "codex-cli",
    name: "Codex CLI Evaluator/Critic Agent",
    description: "Shared codex-cli agent for the CLI generator/critic showcase loop; per-session dispatch, shared JuiceFS workspace at /sandbox/work."
  });
  await ensureCliShowcaseAgentFor(params.sqlClient, params.userId, params.projectId, {
    slug: "codex-playwright-critic-agent",
    runtime: "codex-cli",
    name: "Codex Playwright Critic Agent",
    description: "codex-cli design critic with the Playwright MCP server; drives Chromium in-pod to inspect the rendered app and judge it against a design rubric.",
    mcpServers: PLAYWRIGHT_CRITIC_MCP
  });
  await ensureCliShowcaseAgentFor(params.sqlClient, params.userId, params.projectId, {
    slug: "agy-cli-evaluator-critic-agent",
    runtime: "agy-cli",
    name: "Antigravity CLI Evaluator/Critic Agent",
    description: "Shared agy-cli (Antigravity) agent for the CLI generator/critic showcase loop; per-session dispatch, shared JuiceFS workspace at /sandbox/work. Requires a captured ~/.gemini bundle (AGY_AUTH_JSON) for headless durable/run."
  });
  await ensureCliShowcaseAgentFor(params.sqlClient, params.userId, params.projectId, {
    slug: "agy-playwright-critic-agent",
    runtime: "agy-cli",
    name: "Antigravity Playwright Critic Agent",
    description: "agy-cli design critic with the Playwright MCP server; drives Chromium in-pod to inspect the rendered app and judge it against a design rubric.",
    mcpServers: PLAYWRIGHT_CRITIC_MCP
  });
  const GAN_PLANNER_PERSONA = "You are the PLANNER in a GAN frontend-redesign harness. You NEVER write or edit application code \u2014 a separate GENERATOR does that, and ANY edit you make to app source is thrown away (this step does not sync). Read the current page for understanding ONLY, then write a single TESTABLE contract as strict JSON to /sandbox/work/contract.json (objective, acceptanceCriteria, designTokens, rubric) and verify it with cat. Stay high-level; do not enumerate granular code steps. The SPECIFIC redesign objective and target page come from YOUR TASK PROMPT (the change request) \u2014 derive the contract's objective, acceptanceCriteria, and rubric STRICTLY from that change request and from reading the current target page; do NOT assume any particular page, product area, or a fixed rubric (never default to a generic monitoring/command-center framing unless the change request asks for it). Write the contract file, then STOP. This is a HEADLESS automated run \u2014 there is NO human. NEVER use AskUserQuestion, NEVER wait for permission or input. When you are blocked, write a concise diagnosis as your final message and STOP the turn; the harness reads your message and the loop continues.";
  const GAN_GENERATOR_PERSONA = "You are the GENERATOR in a GAN frontend-redesign harness. You build and iterate the REAL UI: pull the dev server source from $EXPORT_URL (/__export), edit ONLY files under src/ to satisfy the contract + the latest critic feedback, push live via $SYNC_URL (/__sync), then STOP. Wire REAL data via +page.server.ts from existing repo endpoints; NEVER fabricate data; graceful empty states. HARD RULES (the critic boots the live page \u2014 broken builds waste a whole iteration): (1) Every server-side data fetch (in +page.server.ts `load` and any server route) MUST be individually guarded \u2014 wrap each in try/catch or use Promise.allSettled \u2014 and degrade THAT region to its empty state. A single failing/empty /api source must NEVER throw and 500 the whole page. (2) IMPORT every component/symbol you reference (e.g. Badge) \u2014 an undefined reference crashes the page on mount. (3) Before you STOP, do a CHEAP smoke check only: curl $PREVIEW_URL + TARGET_ROUTE and confirm HTTP 200 (not 500) and no top-level ReferenceError \u2014 do NOT do a full visual self-grade (the Playwright critic does that; grading cold vite wastes the turn). If the smoke check fails, fix it before stopping. (4) When you fix a critic point, do NOT regress a previously-working area \u2014 keep all prior guards/imports intact. (5) Leave NO debug/scratch routes or files in the diff (no /api/v1/debug-*, no throwaway endpoints). Keep existing functionality working; NEVER touch the sign-in/auth pages. This is a HEADLESS automated run \u2014 there is NO human. NEVER use AskUserQuestion, NEVER wait for permission or input. When you are blocked, write a concise diagnosis as your final message and STOP the turn; the harness reads your message and the loop continues.";
  const GAN_CRITIC_PERSONA = 'You are the EVALUATOR/CRITIC in a GAN frontend-redesign harness (Anthropic skeptical-evaluator pattern). You NEVER write code. Using your Playwright MCP tools you log into the LIVE app with the provided credentials, drive the real DOM at desktop AND mobile widths, and grade it strictly against the contract + rubric, DEFAULTING TO NOT SATISFIED. Boot the live app, never grade from a static diff. READINESS: the dev preview RESTARTS on every /__sync, so its URL flaps between grades \u2014 before grading EACH route, poll it (a cheap GET, e.g. PREVIEW_URL/api/health) and retry for up to ~90s until HTTP 200, then navigate (keep a 180000 ms navigation timeout + a retry or two); a transient 502/503/connection-reset/blank page during that window is the restart, NOT a defect. CLASSIFY every problem into exactly one bucket: FEATURE defects \u2014 perRoute + feedback (these gate acceptance); IN-APP issues in THIS repo\'s own src but OUTSIDE the feature (a broken shared component, a server-adapter data-shape bug, an app-shell defect like the mobile nav never collapsing or a favicon 404 the app itself serves) \u2014 the `ecosystemIssues` array as {area,detail,suggestedFix} (REQUIRED reporting, but they do NOT lower `score` or block `meets_criteria`); INFRASTRUCTURE failures OUTSIDE the app\'s code (other services 5xx e.g. /metrics, DB/cluster/timeout, preview machinery) \u2014 the `envIssues` array (do NOT lower `score`). HARD BOUNDARY: if it lives in this repo\'s src it is NEVER an env issue; a failure that also reproduces on an unchanged route is an in-app (ecosystem) issue, not a feature defect. Grade the CHANGE the generator made. VERDICT FILE (do this FIRST, before your final message): when your task prompt gives you an iteration index, mkdir -p /sandbox/work/gan and write the exact verdict JSON below \u2014 PLUS two extra keys "iteration":<idx> and "schema":"gan.verdict/v1" \u2014 to /sandbox/work/gan/verdict-<idx>.json. The file is the PRIMARY loop-exit signal; your final message is the fallback. OUTPUT CONTRACT (a machine parses your FINAL message to decide whether the loop stops \u2014 this is critical): your FINAL message MUST be EXACTLY the strict JSON verdict object and NOTHING ELSE, of the shape {"meets_criteria":<bool>,"score":<0-10>,"perRoute":[{"route":<string>,"passes":<bool>,"note":<string>}],"ecosystemIssues":[{"area":<string>,"detail":<string>,"suggestedFix":<string>}],"envIssues":[{"route":<string>,"detail":<string>}],"feedback":<string>}. It MUST start with `{` and end with `}`. Do NOT add any preamble, \'Summary of findings\', explanation, or commentary before or after it, and do NOT wrap it in ``` markdown fences. Put ALL of your reasoning INSIDE the JSON\'s `feedback` field (in-app-but-out-of-feature issues go in `ecosystemIssues`, infrastructure failures go in `envIssues`, not `feedback`). If you emit any text outside the JSON, the harness cannot read your verdict and the loop will run forever. This is a HEADLESS automated run \u2014 there is NO human. NEVER use AskUserQuestion, NEVER wait for permission or input. When you are blocked, write a concise diagnosis as your final message and STOP the turn; the harness reads your message and the loop continues.';
  const GAN_CLI_RUNTIMES = [
    { suffix: "claude", runtime: "claude-code-cli", label: "Claude Code" },
    { suffix: "codex", runtime: "codex-cli", label: "Codex" },
    { suffix: "agy", runtime: "agy-cli", label: "Antigravity" }
  ];
  for (const cli of GAN_CLI_RUNTIMES) {
    await ensureCliShowcaseAgentFor(params.sqlClient, params.userId, params.projectId, {
      slug: `gan-planner-${cli.suffix}`,
      runtime: cli.runtime,
      name: `GAN Planner (${cli.label})`,
      description: `${cli.label} PLANNER for the GAN frontend-redesign harness \u2014 writes the testable contract, never app code.`,
      instructions: GAN_PLANNER_PERSONA
    });
    await ensureCliShowcaseAgentFor(params.sqlClient, params.userId, params.projectId, {
      slug: `gan-generator-${cli.suffix}`,
      runtime: cli.runtime,
      name: `GAN Generator (${cli.label})`,
      description: `${cli.label} GENERATOR for the GAN frontend-redesign harness \u2014 builds/iterates the UI via /__export + /__sync.`,
      instructions: GAN_GENERATOR_PERSONA
    });
    await ensureCliShowcaseAgentFor(params.sqlClient, params.userId, params.projectId, {
      slug: `gan-critic-${cli.suffix}`,
      runtime: cli.runtime,
      name: `GAN Critic (${cli.label})`,
      description: `${cli.label} skeptical Playwright EVALUATOR for the GAN frontend-redesign harness \u2014 logs in, grades the live app against the contract.`,
      mcpServers: PLAYWRIGHT_CRITIC_MCP,
      instructions: GAN_CRITIC_PERSONA
    });
  }
  const GAN_GENERATOR_ULTRACODE_PERSONA = `You are a SENIOR PRODUCT ENGINEER driving a UI feature or refactor against a LIVE, hot-reloading workflow-builder preview \u2014 the dev pod IS the source of truth and serves warm vite SSR. You hold a high craft bar and HEXAGONAL-ARCHITECTURE discipline: keep domain/application logic in the application ports (src/lib/server/application) and push framework/IO concerns to adapters + routes; never leak DB, HTTP, or SvelteKit specifics into domain code; respect the module boundaries the repo already enforces (depcruise / check:boundaries). ECOSYSTEM SCOPE: this preview is fully isolated, so beyond the feature, if the app's OWN code blocks or degrades the evaluated routes (a server-adapter data-shape bug, a broken shared component, an app-shell defect like the nav not collapsing on mobile), FIX IT TOO \u2014 keep the change minimal and tested, the gate must stay green, and NEVER touch the sign-in/auth pages; do not declare in-app issues out of scope. You work in one of two modes, chosen by YOUR TASK PROMPT: PLAN mode (the prompt asks for a contract) \u2014 read the current target routes for understanding ONLY; NEVER write app code (this step does not sync and any edits are discarded). Write ONE testable contract as strict JSON to /sandbox/work/contract.json (objective, acceptanceCriteria, designTokens, rubric), cat it to verify, then STOP. Derive everything from the change request; do NOT assume a fixed product area or a generic rubric. BUILD mode (the prompt asks you to implement) \u2014 each turn: (1) PULL the complete receiver-owned source set: FIRST pick a writable scratch root (SCRATCH=/sandbox/scratch if /sandbox/scratch is writable, else SCRATCH=/tmp/scratch; mkdir -p "$SCRATCH" \u2014 never assume /sandbox/scratch exists), then rm -rf "$SCRATCH/repo" && mkdir -p "$SCRATCH/repo" && curl -sS -H "x-sync-token: $SYNC_TOKEN" -D "$SCRATCH/export.headers" "$EXPORT_URL" -o "$SCRATCH/source.tgz" && ROOTS_JSON="$(sed -n 's/^x-sync-roots:[[:space:]]*//p' "$SCRATCH/export.headers" | tr -d '\\r' | tail -1)" && printf '%s' "$ROOTS_JSON" | jq -e 'type == "array" and length > 0' >/dev/null && tar -xzf "$SCRATCH/source.tgz" -C "$SCRATCH/repo". (2) Implement the feature editing ONLY files under src/ (plus any shared-contract dirs the preview syncs) to satisfy the contract + latest critic feedback; wire REAL data via +page.server.ts from EXISTING repo endpoints, NEVER fabricate data, and guard EACH server-side fetch independently (try/catch or Promise.allSettled) so one failing/empty source degrades THAT region to its empty state and never 500s the page; IMPORT every symbol you reference. KNOWN LANDMINE in this repo: list endpoints (dashboard recent-changes/agents/runs) can return entries with DUPLICATE ids (same resource, multiple versions); in Svelte 5 a keyed {#each} with a duplicate key throws each_key_duplicate during hydration and unmounts the whole subtree even though SSR looks fine \u2014 ALWAYS dedupe lists in the server load AND key {#each} blocks by a guaranteed-unique composite (id + version/index). Keep existing functionality working, NEVER touch the sign-in/auth pages, and leave NO debug/scratch routes in the diff. (3) PUSH one atomic generation: cd "$SCRATCH/repo" && GEN="$(cat /proc/sys/kernel/random/uuid)" && printf '%s' "$ROOTS_JSON" | jq -r '.[]' > "$SCRATCH/declared-roots" && : > "$SCRATCH/existing-roots" && while IFS= read -r p; do [ ! -e "$p" ] || printf '%s\\n' "$p" >> "$SCRATCH/existing-roots"; done < "$SCRATCH/declared-roots" && tar -czf "$SCRATCH/sync.tgz" -T "$SCRATCH/existing-roots" && curl -sS -X POST --data-binary @"$SCRATCH/sync.tgz" -H 'content-type: application/gzip' -H "x-sync-token: $SYNC_TOKEN" -H "x-sync-generation: $GEN" -H 'x-sync-service: workflow-builder' -H "x-sync-roots: $ROOTS_JSON" "$SYNC_URL"; never reuse a generation with different bytes. (4) SMOKE before you stop: this preview exposes NO /__run endpoint \u2014 NEVER call /__run (it 404s and validates nothing). A 302 \u2192 /auth/sign-in on app routes is HEALTHY (the auth guard), never a failure \u2014 for an AUTHENTICATED smoke, sign in once to a cookie jar via POST $PREVIEW_URL/api/v1/auth/sign-in with the provided previewLogin/previewPassword, then curl each target route with that cookie and confirm HTTP 200 with no top-level ReferenceError and no each_key_duplicate in the served HTML; fix any 500/crash (usually an unguarded server load or a missing import) before stopping, and NEVER edit the sign-in page. A deterministic gate step then runs pnpm check + check:boundaries + test-unit against a full checkout of your synced src and feeds any failures back into your next turn's prompt \u2014 fix them there; a separate Playwright critic grades the live routes. Do NOT do a full visual self-grade (the critic does that; grading cold vite wastes the turn). When you address a critic point, do NOT regress a previously-working area. End with a one-line summary of what you changed. This is a HEADLESS automated run \u2014 there is NO human. NEVER use AskUserQuestion, NEVER wait for permission or input. When you are blocked, write a concise diagnosis as your final message and STOP the turn; the harness reads your message and the loop continues.`;
  await ensureCliShowcaseAgentFor(params.sqlClient, params.userId, params.projectId, {
    slug: "gan-generator-ultracode",
    runtime: "claude-code-cli",
    name: "GAN Generator (Ultracode)",
    description: "claude-code-cli senior-product-engineer planner/generator pinned to Opus 4.8 at ultracode effort; builds UI features against a live preview via /__export + /__sync and smoke-checks the routes (this preview has NO /__run endpoint) before a deterministic gate + Playwright critic evaluate.",
    modelSpec: "claude-opus-4-8",
    effort: "ultracode",
    instructions: GAN_GENERATOR_ULTRACODE_PERSONA
  });
  const hostPreviewLifecycle = hostPreviewLifecycleDefinition();
  await upsertRawWorkflow({
    db: params.db,
    workflowId: "preview-development-lifecycle",
    name: "Preview development lifecycle",
    description: hostPreviewLifecycle.description,
    userId: params.userId,
    projectId: params.projectId,
    spec: {
      engine: "dynamic-script",
      script: hostPreviewLifecycle.script,
      meta: hostPreviewLifecycle.meta
    },
    nodes: [],
    edges: [],
    visibility: "public",
    engineType: "dynamic-script"
  });
  const previewUiDevelopmentGan = previewUiDevelopmentGanDefinition();
  await upsertPreviewHmrGateCodeFunction({ db: params.db, userId: params.userId });
  await upsertRawWorkflow({
    db: params.db,
    workflowId: "preview-ui-development-gan",
    name: "Preview UI development GAN",
    description: previewUiDevelopmentGan.description,
    userId: params.userId,
    projectId: params.projectId,
    spec: {
      engine: "dynamic-script",
      script: previewUiDevelopmentGan.script,
      meta: previewUiDevelopmentGan.meta
    },
    nodes: [],
    edges: [],
    visibility: "public",
    engineType: "dynamic-script"
  });
  const dir = path.resolve(process.cwd(), "scripts/fixtures/generator-critic");
  for (const file of [
    // Same GAN harness re-authored for dapr-agent-py on the openshell-shared
    // backend: a workspace/profile provisions ONE shared /sandbox sandbox + a
    // deterministic clone_repo; all durable/run agents (evaluator-critic-agent)
    // bind it via sandboxName/workspaceRef; the spine is plain workspace/command
    // (no cliWorkspace). Code profiles (library/service); default library on
    // jonschlinkert/is-number. ui-web/browser eval is a follow-up.
    "gan-harness-dapr-showcase.json",
    // Minimal clone + single-agent-edit workflow: fast verification of W3
    // local-build, uid alignment, durable source-bundle persistence, and
    // concurrency-safe parallel tool calls — no GAN plan/negotiate/refine loop.
    "bundle-proof.json",
    // Self-update P1: clone workflow-builder, edit a visible UI string, push src to
    // the workflow-builder-dev (vite/HMR) pod via Dapr service invocation (/__sync),
    // and verify the change is LIVE on the preview — skaffold-style live-sync from a
    // workflow, no kubectl/RBAC. See docs/agentic-deploy-inspect-loop.md.
    "workflow-builder-self-edit-livesync.json",
    // P3: generalized per-service dev preview + interactive coding-agent handoff.
    "microservice-dev-session.json",
    // In-preview GAN dev loop: enter preview-native dev mode (dev pod replaces the
    // prod BFF, serves HMR) → clone → generator edits+./sync.sh ↔ Playwright visual
    // critic inspects the LIVE preview URL, looping until accepted. Runs INSIDE a
    // Tier-2 preview. docs/agentic-deploy-inspect-loop.md.
    "preview-dev-gan.json",
    // Comprehensive GAN frontend redesign (Anthropic harness, V2-simplified): Planner
    // authors a testable JSON contract + frontend-design token system → two-pass
    // design_review → refine loop (trimmed generator edit→/__sync ↔ skeptical Playwright
    // critic that LOGS IN, boots the live authenticated page, grades per-criterion) →
    // per-iteration tar-overlay snapshot → promote→PR. dev-pod-as-source, per-CLI.
    "preview-gan-redesign.json",
    // Generic GAN UI-feature/refactor loop against the ADOPTED workflow-builder
    // preview (dev pod becomes the BFF): Planner (gan-generator-ultracode, Opus 4.8
    // ultracode) writes a contract → two-pass design_review → generate ↔ skeptical
    // Playwright critic over evaluationRoutes → per-iteration snapshot → promote→PR
    // on PittampalliOrg/workflow-builder. Task is passed as `intent` at run time.
    "preview-gan-ui-feature.json"
  ]) {
    const full = path.join(dir, file);
    if (!fs2.existsSync(full)) {
      console.warn(`[seed-workflows] generator-critic fixture missing: ${full}`);
      continue;
    }
    const spec = JSON.parse(fs2.readFileSync(full, "utf8"));
    const doc = spec.document || {};
    const id = doc.name || file.replace(/\.json$/, "");
    const { nodes, edges } = buildGeneratorCriticGraph(spec);
    await upsertRawWorkflow({
      db: params.db,
      workflowId: id,
      name: doc.title || id,
      description: doc.summary || "",
      userId: params.userId,
      projectId: params.projectId,
      spec,
      nodes,
      edges,
      visibility: "public"
    });
  }
  const topDir = path.resolve(process.cwd(), "scripts/fixtures");
  for (const file of ["pr-heavy-review.workflow.json"]) {
    const full = path.join(topDir, file);
    if (!fs2.existsSync(full)) {
      console.warn(`[seed-workflows] workflow fixture missing: ${full}`);
      continue;
    }
    const raw = JSON.parse(fs2.readFileSync(full, "utf8"));
    const spec = raw.spec || raw;
    const doc = spec.document || {};
    const id = doc.name || file.replace(/\.workflow\.json$/, "");
    const { nodes, edges } = buildGeneratorCriticGraph(spec);
    await upsertRawWorkflow({
      db: params.db,
      workflowId: id,
      name: raw.name || doc.title || id,
      description: doc.summary || "",
      userId: params.userId,
      projectId: params.projectId,
      spec,
      nodes,
      edges,
      visibility: "public"
    });
  }
}
async function seedWorkflow() {
  console.log("[seed-workflows] Starting workflow seed...");
  const sql2 = src_default(DATABASE_URL2, { max: 1 });
  const db = drizzle(sql2, {
    schema: {
      agentProfileTemplateVersions,
      appConnections,
      projectMembers,
      projects,
      userIdentities,
      users,
      workflowResourceRefs,
      workflows
    }
  });
  try {
    const userId = await resolveGithubUserId(db);
    const projectId = await resolveProjectId(db, userId);
    const githubConnection = await resolveLatestGithubConnection(db, userId);
    console.log(
      `[seed-workflows] Target owner userId=${userId} projectId=${projectId}`
    );
    if (githubConnection) {
      console.log(
        `[seed-workflows] Using GitHub connection ${githubConnection.connectionId} (${githubConnection.connectionExternalId})`
      );
    }
    if (!githubConnection) {
      console.warn(
        "[seed-workflows] No GitHub connection found for the resolved user; the clone proof workflow will require manual connection selection before it can run."
      );
    }
    await migrateKimiK3BrowserAgentsAndWorkflows(sql2, { userId, projectId });
    const profileVersion = await resolveAgentProfileVersion(db);
    const nodes = buildNodes2(profileVersion);
    const edges = buildEdges2();
    await upsertWorkflow({
      db,
      workflowId: WORKFLOW_ID2,
      name: WORKFLOW_NAME2,
      description: WORKFLOW_DESCRIPTION2,
      userId,
      projectId,
      nodes,
      edges
    });
    await db.delete(workflowResourceRefs).where(eq(workflowResourceRefs.workflowId, WORKFLOW_ID2));
    await db.insert(workflowResourceRefs).values([
      {
        id: generateId(),
        workflowId: WORKFLOW_ID2,
        nodeId: IDs.plan,
        resourceType: "agent_profile",
        resourceId: AGENT_PROFILE_TEMPLATE_ID,
        resourceVersion: profileVersion
      },
      {
        id: generateId(),
        workflowId: WORKFLOW_ID2,
        nodeId: IDs.execute,
        resourceType: "agent_profile",
        resourceId: AGENT_PROFILE_TEMPLATE_ID,
        resourceVersion: profileVersion
      }
    ]);
    console.log(
      `[seed-workflows] Reconciled workflow_resource_refs for ${WORKFLOW_ID2} (profile version ${profileVersion})`
    );
    await upsertWorkflow({
      db,
      workflowId: AI_CODING_AGENT_WORKFLOW_ID,
      name: AI_CODING_AGENT_WORKFLOW_NAME,
      description: AI_CODING_AGENT_WORKFLOW_DESCRIPTION,
      userId,
      projectId,
      nodes: buildAiCodingAgentNodes(),
      edges: buildAiCodingAgentEdges()
    });
    const threeBOneBAgentRef = THREE_B_ONE_B_AGENT_OVERRIDE_ID ? {
      id: THREE_B_ONE_B_AGENT_OVERRIDE_ID,
      version: THREE_B_ONE_B_AGENT_OVERRIDE_VERSION
    } : await ensureKimiAgent(sql2, { userId, projectId });
    await upsertRawWorkflow({
      db,
      workflowId: THREE_B_ONE_B_WORKFLOW_ID,
      name: THREE_B_ONE_B_WORKFLOW_NAME,
      description: THREE_B_ONE_B_WORKFLOW_DESCRIPTION,
      userId,
      projectId,
      spec: buildThreeBOneBWorkflowSpec(threeBOneBAgentRef),
      nodes: buildThreeBOneBWorkflowNodes(),
      edges: buildThreeBOneBWorkflowEdges(),
      visibility: "public"
    });
    await upsertRawWorkflow({
      db,
      workflowId: THREE_B_ONE_B_CLI_WORKFLOW_ID,
      name: THREE_B_ONE_B_CLI_WORKFLOW_NAME,
      description: THREE_B_ONE_B_CLI_WORKFLOW_DESCRIPTION,
      userId,
      projectId,
      spec: buildThreeBOneBCliWorkflowSpec(),
      nodes: buildThreeBOneBCliWorkflowNodes(),
      edges: buildThreeBOneBCliWorkflowEdges(),
      visibility: "public"
    });
    await upsertRawWorkflow({
      db,
      workflowId: SVELTEKIT_GAME_WORKFLOW_ID,
      name: SVELTEKIT_GAME_WORKFLOW_NAME,
      description: SVELTEKIT_GAME_WORKFLOW_DESCRIPTION,
      userId,
      projectId,
      spec: buildSvelteKitGameWorkflowSpec(),
      nodes: buildSvelteKitGameWorkflowNodes(),
      edges: buildSvelteKitGameWorkflowEdges(),
      visibility: "public"
    });
    await upsertRawWorkflow({
      db,
      workflowId: CODING_GOAL_WORKFLOW_ID,
      name: CODING_GOAL_WORKFLOW_NAME,
      description: CODING_GOAL_WORKFLOW_DESCRIPTION,
      userId,
      projectId,
      spec: buildCodingGoalWorkflowSpec(),
      nodes: buildCodingGoalWorkflowNodes(),
      edges: buildCodingGoalWorkflowEdges(),
      visibility: "public"
    });
    {
      const romanCfg = buildRomanGoalConfig();
      await upsertRawWorkflow({
        db,
        workflowId: romanCfg.id,
        name: romanCfg.name,
        description: romanCfg.description,
        userId,
        projectId,
        spec: buildEvaluatorGoalWorkflowSpec(romanCfg),
        nodes: buildEvaluatorGoalWorkflowNodes(romanCfg),
        edges: buildEvaluatorGoalWorkflowEdges(),
        visibility: "public"
      });
    }
    {
      const plannedCfg = buildPlannedGoalConfig();
      await upsertRawWorkflow({
        db,
        workflowId: plannedCfg.id,
        name: plannedCfg.name,
        description: plannedCfg.description,
        userId,
        projectId,
        spec: buildPlannedGoalWorkflowSpec(plannedCfg),
        nodes: buildPlannedGoalWorkflowNodes(plannedCfg),
        edges: buildPlannedGoalWorkflowEdges(),
        visibility: "public"
      });
    }
    {
      const plannerAgentCfg = buildPlannedGoalAgentConfig();
      await upsertRawWorkflow({
        db,
        workflowId: plannerAgentCfg.id,
        name: plannerAgentCfg.name,
        description: plannerAgentCfg.description,
        userId,
        projectId,
        spec: buildPlannedGoalAgentWorkflowSpec(plannerAgentCfg),
        nodes: buildPlannedGoalAgentWorkflowNodes(),
        edges: buildPlannedGoalAgentWorkflowEdges(),
        visibility: "public"
      });
    }
    await seedGeneratorCriticShowcases({ db, sqlClient: sql2, userId, projectId });
    await seedHostPreviewLifecycleForAdminProjects({
      db,
      canonicalProjectId: projectId
    });
    await upsertWorkflow({
      db,
      workflowId: OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_ID,
      name: OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_NAME,
      description: OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_DESCRIPTION,
      userId,
      projectId,
      nodes: buildOpenShellLangGraphFeatureDeliveryNodes({
        connectionId: githubConnection?.connectionId,
        connectionExternalId: githubConnection?.connectionExternalId,
        agentProfileVersion: profileVersion
      }),
      edges: buildOpenShellLangGraphFeatureDeliveryEdges(),
      visibility: "public"
    });
    await db.delete(workflowResourceRefs).where(
      eq(
        workflowResourceRefs.workflowId,
        OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_ID
      )
    );
    await db.insert(workflowResourceRefs).values([
      {
        id: generateId(),
        workflowId: OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_ID,
        nodeId: OPENSHELL_FEATURE_IDS.plan,
        resourceType: "agent_profile",
        resourceId: AGENT_PROFILE_TEMPLATE_ID,
        resourceVersion: profileVersion
      },
      {
        id: generateId(),
        workflowId: OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_ID,
        nodeId: OPENSHELL_FEATURE_IDS.execute,
        resourceType: "agent_profile",
        resourceId: AGENT_PROFILE_TEMPLATE_ID,
        resourceVersion: profileVersion
      }
    ]);
    console.log(
      `[seed-workflows] Reconciled workflow_resource_refs for ${OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_ID} (profile version ${profileVersion})`
    );
    await upsertWorkflow({
      db,
      workflowId: GITHUB_SANDBOX_CLONE_PROOF_WORKFLOW_ID,
      name: GITHUB_SANDBOX_CLONE_PROOF_WORKFLOW_NAME,
      description: GITHUB_SANDBOX_CLONE_PROOF_WORKFLOW_DESCRIPTION,
      userId,
      projectId,
      nodes: buildGithubSandboxCloneProofNodes(githubConnection),
      edges: buildGithubSandboxCloneProofEdges()
    });
    await upsertWorkflow({
      db,
      workflowId: GITHUB_SANDBOX_REVIEW_WORKFLOW_ID,
      name: GITHUB_SANDBOX_REVIEW_WORKFLOW_NAME,
      description: GITHUB_SANDBOX_REVIEW_WORKFLOW_DESCRIPTION,
      userId,
      projectId,
      nodes: buildGithubSandboxReviewNodes(githubConnection),
      edges: buildGithubSandboxReviewEdges()
    });
    await upsertWorkflow({
      db,
      workflowId: AGENT_SYSTEM_DEMO_WORKFLOW_ID,
      name: AGENT_SYSTEM_DEMO_WORKFLOW_NAME,
      description: AGENT_SYSTEM_DEMO_WORKFLOW_DESCRIPTION,
      userId,
      projectId,
      nodes: buildAgentSystemDemoNodes(githubConnection),
      edges: buildAgentSystemDemoEdges()
    });
    console.log("[seed-workflows] Completed successfully");
  } finally {
    await sql2.end();
  }
}
seedWorkflow().catch((error) => {
  console.error("[seed-workflows] Failed:", error);
  process.exit(1);
});
