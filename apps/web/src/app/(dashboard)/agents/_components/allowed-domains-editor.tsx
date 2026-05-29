"use client";

import { useState } from "react";
import { Loader2, Trash2, Globe } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { useRules, useCreateRule, useDeleteRule } from "@/hooks/use-rules";

interface AllowedDomainsEditorProps {
  agentId: string;
}

export const AllowedDomainsEditor = ({
  agentId,
}: AllowedDomainsEditorProps) => {
  const { data: allRules = [], isPending: loading } = useRules();
  const createRule = useCreateRule();
  const deleteRule = useDeleteRule();
  const [hostInput, setHostInput] = useState("");

  const allowRules = allRules.filter(
    (r) => r.action === "allow" && r.agentId === agentId,
  );

  const handleAdd = () => {
    const trimmed = hostInput.trim();
    if (!trimmed) return;
    createRule.mutate(
      {
        name: trimmed,
        hostPattern: trimmed,
        action: "allow",
        enabled: true,
        agentId,
      },
      {
        onSuccess: () => setHostInput(""),
      },
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleAdd();
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          placeholder="e.g. api.example.com"
          value={hostInput}
          onChange={(e) => setHostInput(e.target.value)}
          onKeyDown={handleKeyDown}
          className="h-8 text-sm"
          disabled={createRule.isPending}
        />
        <Button
          size="sm"
          onClick={handleAdd}
          disabled={!hostInput.trim() || createRule.isPending}
          loading={createRule.isPending}
          className="shrink-0"
        >
          Add
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        </div>
      ) : allowRules.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-6 text-center">
          <Globe className="text-muted-foreground mb-2 size-4" />
          <p className="text-muted-foreground text-xs">
            No allowed domains yet
          </p>
        </div>
      ) : (
        <ul className="divide-border divide-y rounded-md border">
          {allowRules.map((rule) => (
            <li
              key={rule.id}
              className="flex items-center justify-between gap-2 px-3 py-2"
            >
              <code className="text-sm">{rule.hostPattern}</code>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                onClick={() => deleteRule.mutate(rule.id)}
                disabled={deleteRule.isPending}
                aria-label={`Remove ${rule.hostPattern}`}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
