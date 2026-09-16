"use client";

import { Select } from "@base-ui/react/select";
import { site } from "@/site.config";

const versions = [{ value: site.version, label: `Version ${site.version}` }];

export function VersionSelect() {
  return <Select.Root items={versions} defaultValue={site.version}>
    <Select.Trigger className="docs-version" aria-label="Protocol version">
      <Select.Value />
      <Select.Icon className="docs-version-chevron">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Positioner className="docs-version-positioner" align="end" sideOffset={8} alignItemWithTrigger={false}>
        <Select.Popup className="docs-version-popup">
          <Select.List>
            {versions.map(({ value, label }) => <Select.Item key={value} value={value} className="docs-version-option">
              <Select.ItemText>{label}</Select.ItemText>
              <Select.ItemIndicator className="docs-version-check">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="m3.5 8 3 3 6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Select.ItemIndicator>
            </Select.Item>)}
          </Select.List>
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  </Select.Root>;
}
