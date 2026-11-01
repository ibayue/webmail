"use client";

import { useTranslations } from "next-intl";
import { SettingItem } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { openMailImport } from "@/stores/mail-transfer-store";

/** Settings > Backup: bring mail in from files. */
export function MailBackupSettings() {
  const tImport = useTranslations("mail_import");
  return (
    <SettingItem label={tImport("settings_label")} description={tImport("settings_description")}>
      <Button variant="outline" size="sm" onClick={() => openMailImport()} data-testid="settings-mail-import">
        {tImport("settings_button")}
      </Button>
    </SettingItem>
  );
}
