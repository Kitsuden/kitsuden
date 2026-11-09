# Calculated Fields / KPI System

Calculated fields integrated into the DataExplorer, so KPIs need no separate view.

## Components

### FormulaBuilder

Visual builder for math formulas.

```svelte
<script>
  import { FormulaBuilder } from "$lib/components/calculated-fields";

  const fields = [
    { name: "price", label: "Price", type: "number" },
    { name: "quantity", label: "Quantity", type: "number" },
    { name: "discount", label: "Discount %", type: "number" },
  ];

  let formula = "{price} * {quantity} * (1 - {discount} / 100)";
</script>

<FormulaBuilder availableFields={fields} bind:value={formula} />
```

### KpiCreator

Complete wizard to create calculated fields of every supported type.

```svelte
<script>
  import { KpiCreator } from "$lib/components/calculated-fields";

  const fields = [
    { name: "revenue", label: "Revenue", type: "number" },
    { name: "cost", label: "Cost", type: "number" },
  ];

  function handleSave(field) {
    console.log("New calculated field:", field);
  }
</script>

<KpiCreator availableFields={fields} onSave={handleSave} />
```

## Calculated field types

| Type          | Description         | Typical use                   |
| ------------- | ------------------- | ----------------------------- |
| `formula`     | Math expression     | `{price} * {quantity}`        |
| `count`       | Count records       | Number of orders per customer |
| `sum`         | Add up values       | Total sales per category      |
| `average`     | Average             | Average order value           |
| `min`, `max`  | Smallest or largest | Latest order date             |
| `concat`      | Join text           | `{firstName} {lastName}`      |
| `date_diff`   | Difference of dates | Days since the last purchase  |
| `conditional` | IF/THEN/ELSE        | `{status} = 'active' ? 1 : 0` |
| `lookup`      | Look up in a table  | Customer name from an ID      |

## Functions in the formula builder

The builder offers these functions (ids as exported by `FORMULA_FUNCTIONS` in `index.ts`):

- **Math:** `abs`, `round`, `ceil`, `floor`, `min`, `max`, `sum`, `avg`, `count`
- **Logic:** `if`, `and`, `or`, `not`
- **Text:** `concat`, `length`, `upper`, `lower`, `substring`, `replace`
- **Date:** `date_diff`, `now`, `today`

## Output format

```typescript
{
  type: "currency",
  currency: "USD",
  decimals: 2,
  prefix: "$",
  suffix: ""
}
```

Format types include:

- `text` - Plain text
- `number` - Number with configurable decimals
- `currency` - Currency with a symbol
- `percentage` - Percentage
- `duration` - Duration (days, hours, minutes)
- `badge` - Visual status with a color

## KPI examples

### Total revenue

```json
{
  "name": "total_revenue",
  "label": "Total Revenue",
  "type": "sum",
  "config": {
    "sourceTable": "orders",
    "sourceField": "amount"
  },
  "format": {
    "type": "currency",
    "currency": "USD"
  },
  "isKpi": true,
  "target": 100000
}
```

### Conversion rate

```json
{
  "name": "conversion_rate",
  "label": "Conversion Rate",
  "type": "formula",
  "config": {
    "expression": "{conversions} / {visitors} * 100"
  },
  "format": {
    "type": "percentage",
    "decimals": 2
  }
}
```

### VIP customer

```json
{
  "name": "is_vip",
  "label": "VIP Status",
  "type": "conditional",
  "config": {
    "condition": {
      "field": "lifetime_value",
      "operator": "gte",
      "value": 10000
    },
    "trueValue": "VIP",
    "falseValue": "Regular"
  },
  "format": {
    "type": "badge",
    "color": "gold"
  }
}
```

### Days inactive

```json
{
  "name": "days_inactive",
  "label": "Days Inactive",
  "type": "date_diff",
  "config": {
    "startField": "last_login",
    "endField": null,
    "unit": "days"
  },
  "format": {
    "type": "number",
    "suffix": " days"
  },
  "isKpi": true,
  "warningThreshold": 30
}
```

## Using them in the DataExplorer

A table column with `type: "calculated"` is rendered by the DataExplorer. See
`src/lib/data-explorer/README.md` for the column configuration and the helper functions.
