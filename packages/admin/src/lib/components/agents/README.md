# AI Control Center - Components

## Overview

UI system for managing and monitoring AI agents in Kitsuden.

## Components

### Timeline

Shows the execution steps of an agent.

```svelte
<script>
  import { Timeline } from "$lib/components/agents";

  const steps = [
    {
      id: "1",
      traceId: "trace-1",
      stepType: "thinking",
      content: { thought: "Analyzing..." },
      tokensUsed: 45,
      latencyMs: 120,
      createdAt: new Date().toISOString(),
    },
  ];
</script>

<Timeline {steps} />
```

### ChatInterface

Interactive chat panel for the playground.

```svelte
<script>
  import { ChatInterface } from "$lib/components/agents";

  let messages = [];
  let loading = false;

  function handleSend(message) {
    // Send to the API
  }
</script>

<ChatInterface {messages} {loading} agentName="My Agent" onSend={handleSend} />
```

### TokenDisplay

Shows a token safely (one-time display).

```svelte
<script>
  import { TokenDisplay } from "$lib/components/agents";

  let token = "kitsuden_agent_xxxxxxxxxxxxxxxx";
</script>

<TokenDisplay {token} />
```

## Routes

- `/agents` - Agent list
- `/agents/:id` - Agent detail (tabs: playground, settings, traces)
- `/traces` - Trace explorer

## API endpoints

See `src/lib/services/agents.ts` for the full list of methods.
