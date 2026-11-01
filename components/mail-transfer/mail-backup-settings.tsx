"use client";

import { useTranslations } from "next-intl";
import { SettingItem } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { openMailExport, openMailImport } from "@/stores/mail-transfer-store";

/** Settings > Backup: bring mail in from files, and save all of it as one file. */
export function MailBackupSettings() {
  const tImport = useTranslations("mail_import");
  const tExport = useTranslations("mail_export");
  return (
    <>
      <SettingItem label={tImport("settings_label")} description={tImport("settings_description")}>
        <Button variant="outline" size="sm" onClick={() => openMailImport()} data-testid="settings-mail-import">
          {tImport("settings_button")}
        </Button>
      </SettingItem>
      <SettingItem label={tExport("settings_label")} description={tExport("settings_description")}>
        <Button variant="outline" size="sm" onClick={() => openMailExport()} data-testid="settings-mail-export">
          {tExport("settings_button")}
        </Button>
      </SettingItem>
    </>
  );
}
