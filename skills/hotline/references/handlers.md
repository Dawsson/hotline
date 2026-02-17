# Handlers

Every handler uses the `{ handler, fields, description }` format. This is required so schemas are advertised to `hotline watch` and agents. No bare functions.

```ts
"my-command": {
  handler: ({ name, count }) => { /* ... */ },
  fields: [
    { name: "name", type: "string", description: "A name" },
    { name: "count", type: "number", optional: true, description: "How many" },
  ],
  description: "Does something useful",
}
```

Field types: `"string"`, `"number"`, `"boolean"`, `"json"`

## Standard Handlers

### State Access

If the app uses any state management (zustand, redux, context, etc.):

```ts
"get-state": {
  handler: ({ key }) => store.getState()[key],
  fields: [{ name: "key", type: "string", description: "State key to fetch" }],
  description: "Get a value from app state",
}
```

### Navigation

If the app uses expo-router or react-navigation:

```ts
"navigate": {
  handler: ({ screen, params }) => {
    // expo-router: router.push(screen)
    // react-navigation: navigation.navigate(screen, params)
  },
  fields: [
    { name: "screen", type: "string", description: "Screen name or path" },
    { name: "params", type: "json", optional: true, description: "Navigation params" },
  ],
  description: "Navigate to a screen",
}
```

### Get Current Route

```ts
"get-route": {
  handler: () => {
    // expo-router: return pathname
    // react-navigation: return navigation.getCurrentRoute()
  },
  description: "Get the current route",
}
```

### Component Tree

For test automation and UI inspection:

```ts
"get-tree": {
  handler: () => {
    // Return a simplified component tree or list of testIDs on screen
  },
  description: "Get the component tree",
}
```

## Custom Handlers

Add whatever makes sense for the app's domain. Always use the `{ handler, fields, description }` format:

```ts
"add-to-cart": {
  handler: ({ productId, quantity }) => cart.add(productId, quantity),
  fields: [
    { name: "productId", type: "string", description: "Product ID" },
    { name: "quantity", type: "number", optional: true, description: "Quantity (default 1)" },
  ],
  description: "Add a product to the cart",
}
```

Handlers can be sync or async. The client library automatically wraps the return value:

```ts
// Success: { id, ok: true, data: <return value> }
// Error:   { id, ok: false, error: <error message> }
// Unknown: { id, ok: false, error: "Unknown command: <type>" }
```
