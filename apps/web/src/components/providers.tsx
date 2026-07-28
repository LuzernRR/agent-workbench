"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 15000, refetchOnWindowFocus: false, retry: 1 },
      mutations: { retry: 0 }
    }
  }));
  return <QueryClientProvider client={client}><TooltipProvider delayDuration={350}>{children}</TooltipProvider></QueryClientProvider>;
}
