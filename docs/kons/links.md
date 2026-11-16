# Link relations

Links between kons are described in [CORE.md](../../CORE.md#links-between-kons-kitsuden_links):
`link`, `neighbors`, `resolveNeighbors` and `unlinkAll` from `@kitsuden/engine`.
This page is the vocabulary: the relation names more than one kon is expected to
share.

`relation` is free text and stays free. But two kons that mean the same thing
must write the same word, or the order a shop linked as `buyer` is invisible to
the CRM that reads `ordered_by`.

## Common relations

`LINK_RELATIONS` in `@kitsuden/shared`:

| Relation      | Direction | `from`                                           | `to`                                | Meaning                                                 |
| ------------- | --------- | ------------------------------------------------ | ----------------------------------- | ------------------------------------------------------- |
| `related`     | none      | anything                                         | anything                            | They have something to do with each other. The default. |
| `same_person` | none      | a person record                                  | another person record               | Two records of the same human being in two kons.        |
| `ordered_by`  | from → to | an order, a booking, a registration              | a person record                     | The order was placed by that person.                    |
| `paid_by`     | from → to | a payment, a subscription, an invoice            | a person or company record          | The payment was made by them.                           |
| `about`       | from → to | a message, a meeting, a note, a document, a task | the contact, deal, order or project | The item concerns that record.                          |

```ts
import { link } from "@kitsuden/engine";

await link(
  { type: "shop_orders", id: order.id },
  { type: "crm_contacts", id: contact.id },
  { relation: "ordered_by" }
);
```

`type` is, by convention, the table name. For a record of a
[kon entity](entities.md) or any dataset entry, use `data_entries`.

## Direction

A directed relation is stored as written: `ordered_by` goes from the order to
the person. Reading with `neighbors` looks at both ends and always returns the
other one, so a reader does not need to know the direction; a writer does, so
that two kons do not store the same fact twice in opposite directions.

A relation with no direction (`related`, `same_person`) is stored with its two
ends in a fixed order (by type, then by id). Writing A–B and then B–A gives one
row.

## Names

Lower case letters, digits and `_`, starting with a letter, at most 64
characters (`LINK_RELATION_NAME`). `link` refuses anything else.

A kon may use a relation that is not in the table (`invited_by`, `attends`). It
is treated as directed. If a second kon needs it, add it to `LINK_RELATIONS`
with its direction instead of letting each kon guess.

## Who can see a link

A link created without `ownerId` can be read by every signed-in user: it says
that two ids are related, never what the records contain. Following a link
always goes through the row policies of the target table. Pass `ownerId` when
the existence of the link is itself private.
