## Context

The toolbar renders from `items`.

## Goals / Non-Goals

**Goals:**

- Filter without a new dependency

**Non-Goals:**

- Fuzzy matching

## Decisions

### Filter in the view

The view filters `items`, so the data layer is unchanged.

## Risks / Trade-offs

- A very large list may need debouncing.