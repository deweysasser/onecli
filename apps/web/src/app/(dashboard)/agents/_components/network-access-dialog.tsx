"use client";

import { useState } from "react";
import { Globe, Lock, Building2 } from "lucide-react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { cn } from "@onecli/ui/lib/utils";
import { setAgentPolicyMode } from "@/lib/actions/agents";
import { getPolicyMode } from "@/lib/actions/policy-mode";
import { queryKeys } from "@/lib/api/keys";
import { AllowedDomainsEditor } from "./allowed-domains-editor";

interface NetworkAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  agentName: string;
  policyMode: "allow" | "deny" | null;
  orgDefaultMode?: "allow" | "deny";
}

type ModeOption = {
  value: "allow" | "deny" | null;
  icon: React.ElementType;
  label: string;
  desc: string;
};

const MODE_OPTIONS: ModeOption[] = [
  {
    value: null,
    icon: Building2,
    label: "Inherit organization default",
    desc: "Use whatever the org policy is set to",
  },
  {
    value: "deny",
    icon: Lock,
    label: "Locked — deny by default",
    desc: "Only explicitly allowed domains are reachable",
  },
  {
    value: "allow",
    icon: Globe,
    label: "Open — unlimited",
    desc: "Agent can reach any external host",
  },
];

export const NetworkAccessDialog = ({
  open,
  onOpenChange,
  agentId,
  agentName,
  policyMode,
  orgDefaultMode = "deny",
}: NetworkAccessDialogProps) => {
  const [localMode, setLocalMode] = useState<"allow" | "deny" | null>(
    policyMode,
  );
  const [saving, setSaving] = useState(false);

  const { data: fetchedOrgMode } = useQuery({
    queryKey: queryKeys.policyMode.get(),
    queryFn: getPolicyMode,
    enabled: open,
  });

  const resolvedOrgDefault = fetchedOrgMode ?? orgDefaultMode;

  // Reset local state when the dialog opens so it reflects the latest prop value
  const handleOpenChange = (next: boolean) => {
    if (next) setLocalMode(policyMode);
    onOpenChange(next);
  };

  const handleSelectMode = async (mode: "allow" | "deny" | null) => {
    if (mode === localMode || saving) return;
    setSaving(true);
    try {
      await setAgentPolicyMode(agentId, mode);
      setLocalMode(mode);
      toast.success("Network access updated");
    } catch {
      toast.error("Failed to update network access");
    } finally {
      setSaving(false);
    }
  };

  const effectiveMode = localMode !== null ? localMode : resolvedOrgDefault;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>Network access for {agentName}</DialogTitle>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Controls which external hosts this agent is allowed to connect to.
          </p>
        </DialogHeader>

        <div className="space-y-2 px-6 pb-4">
          <p className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
            Network mode
          </p>
          <div className="flex flex-col gap-2">
            {MODE_OPTIONS.map(({ value, icon: Icon, label, desc }) => {
              const isSelected = localMode === value;
              return (
                <button
                  key={String(value)}
                  type="button"
                  onClick={() => handleSelectMode(value)}
                  disabled={saving}
                  className={cn(
                    "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                    isSelected
                      ? "border-foreground/30 bg-muted/60"
                      : "border-border hover:bg-muted/30",
                    saving && "cursor-not-allowed opacity-60",
                  )}
                >
                  <Icon
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0",
                      isSelected
                        ? "text-foreground"
                        : "text-muted-foreground/60",
                    )}
                  />
                  <div>
                    <p
                      className={cn(
                        "text-sm font-medium",
                        !isSelected && "text-muted-foreground",
                      )}
                    >
                      {label}
                    </p>
                    <p className="text-muted-foreground text-xs">{desc}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {effectiveMode === "deny" && (
          <div className="border-border/50 border-t px-6 pt-4 pb-6 space-y-3">
            <div>
              <p className="text-sm font-medium">Allowed domains</p>
              <p className="text-muted-foreground text-xs mt-0.5">
                Domains this agent may reach when operating in locked mode.
              </p>
            </div>
            <AllowedDomainsEditor agentId={agentId} />
          </div>
        )}

        {effectiveMode === "allow" && (
          <div className="border-border/50 border-t px-6 py-4">
            <p className="text-muted-foreground text-xs">
              This agent has unrestricted access to external hosts.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
