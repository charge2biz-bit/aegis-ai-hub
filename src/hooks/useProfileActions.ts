import { useState, useCallback } from 'react';
import { nexusApi } from '../api/nexusApi';
import { useTranslation } from './useTranslationHook';
import { useErrorHandler } from './useErrorHandler';
import type { NexusSettings, EditorTab } from '../types';
import type { DialogType } from '../components/CustomDialog';

interface UseProfileActionsProps {
  draft: NexusSettings;
  setDraft: React.Dispatch<React.SetStateAction<NexusSettings>>;
  currentSettings: NexusSettings;
  onSave: (newSettings: NexusSettings) => Promise<void>;
  apiKey: string;
  customAlert: (title: string, message: string, type?: DialogType) => Promise<void>;
  customConfirm: (title: string, message: string) => Promise<boolean>;
  customPrompt: (title: string, message: string, defaultValue?: string, placeholder?: string) => Promise<string | null>;
  setActiveTab: (tab: EditorTab) => void;
  setSelectedCategory: (name: string | null) => void;
}

/**
 * プロファイル全体の永続化、AIによる構造最適化、初期化などの高レベル操作を管理するカスタムフック。
 * 
 * 【設計思想】
 * - 単一のカテゴリ操作を超えた、設定データ全体のライフサイクル（保存・変換・リセット）を統括します。
 * - 多言語対応（日本語設定時の英語翻訳など）や、AIによるカテゴリの再構築（Restructure）といった、
 *   複雑かつ時間のかかるビジネスロジックをコンポーネントから分離します。
 * 
 * 【実装の意図】
 * - `handleSave` では、言語設定が英語の場合に日本語が含まれていないかをチェックし、
 *   必要に応じて自動的にAI翻訳を介在させることで、英語圏ユーザー向けの最適化を自動化しています。
 * - `handleRestructure` では、フェーズを分けた進捗表示（restructureStep）を提供し、
 *   「何が起きているか」をユーザーに明示することで、AIによる大幅な変更への不安を軽減しています。
 * - 全ての重要操作の前後で `onSave` を呼び出し、データの永続化を確実に行っています。
 */
export function useProfileActions({
  draft,
  setDraft,
  currentSettings,
  onSave,
  apiKey,
  customAlert,
  customConfirm,
  customPrompt,
  setActiveTab,
  setSelectedCategory
}: UseProfileActionsProps) {
  const { t, language } = useTranslation();
  const { handleError } = useErrorHandler(customAlert);
  const [isSaving, setIsSaving] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [restructureStep, setRestructureStep] = useState<string | null>(null);
  const [isReacquiring, setIsReacquiring] = useState(false);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      let draftToSave = draft;
      if (language === 'en') {
        const hasJapanese = (str: string) => /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf]/.test(str);
        let needsTranslation = false;
        for (const [catName, catData] of Object.entries(draftToSave.interests.categories)) {
          if (hasJapanese(catName) || catData.brands.some(hasJapanese) || catData.keywords.some(hasJapanese)) {
            needsTranslation = true; break;
          }
        }
        if (needsTranslation) {
          setIsTranslating(true);
          try {
            const translatedResult = await nexusApi.translateInterests(draftToSave);
            draftToSave = { ...draftToSave, interests: translatedResult.interests, feedConfig: translatedResult.feedConfig };
            setDraft(draftToSave);
          } catch (e) {
            console.error('Translation failed', e);
          } finally {
            setIsTranslating(false);
          }
        }
      }
      await onSave(draftToSave);
      await customAlert(t.dialog.success, t.handlers.saveSuccess, 'success');
    } catch (err) {
      await handleError(err, t.dialog.saveFailed, 'Save failed');
    } finally {
      setIsSaving(false);
    }
  }, [draft, language, onSave, customAlert, t, setDraft, handleError]);

  const handleRestructure = useCallback(async () => {
    if (!apiKey) {
      await customAlert(t.dialog.apiKeyRequired, t.handlers.apiKeyRequiredSimple, 'warning');
      setActiveTab('system');
      return;
    }
    const countInput = await customPrompt(t.dialog.deepAiRestructure, t.handlers.restructurePrompt, '10', t.handlers.restructurePlaceholder);
    if (!countInput) return;
    const targetCount = parseInt(countInput, 10);
    if (isNaN(targetCount) || targetCount < 5 || targetCount > 15) {
      await customAlert(t.dialog.invalidNumber, t.handlers.restructureInvalid, 'error');
      return;
    }
    if (!(await customConfirm(t.dialog.deepAiRestructure, t.handlers.restructureConfirm.replace('{count}', String(targetCount))))) return;

    setRestructureStep(t.handlers.restructurePhase1.replace('{count}', String(targetCount)));
    try {
      const restructured = await nexusApi.restructureCategories(targetCount, language);
      setRestructureStep(t.handlers.restructurePhase2);
      await new Promise(resolve => setTimeout(resolve, 1000));
      const newDraft: NexusSettings = {
        ...draft,
        interests: { ...draft.interests, categories: restructured.categories, lastUpdated: Date.now() },
        feedConfig: restructured.feedConfig
      };
      setDraft(newDraft);
      setSelectedCategory(Object.keys(restructured.categories)[0] || null);
      setRestructureStep(null);
      await customAlert(t.dialog.restructureComplete, t.handlers.restructureSuccess, 'success');
      await onSave(newDraft);
    } catch (err) {
      setRestructureStep(null);
      await handleError(err, t.dialog.restructureFailed, 'Restructure failed');
    }
  }, [apiKey, customAlert, customConfirm, customPrompt, draft, language, onSave, setActiveTab, t, setDraft, setSelectedCategory, handleError]);

  const handleResetToDefaults = useCallback(async () => {
    if (!(await customConfirm(t.dialog.restoreDefaultProfile, t.handlers.resetConfirm))) return;
    setIsSaving(true);
    try {
      await nexusApi.resetToDefaults();
      await customAlert(t.dialog.success, t.handlers.resetSuccess, 'success');
      window.location.reload();
    } catch (err) {
      await handleError(err, t.dialog.error, 'Reset failed');
    } finally {
      setIsSaving(false);
    }
  }, [customConfirm, customAlert, t, handleError]);

  const handleReacquireAllFeeds = useCallback(async () => {
    if (!apiKey) {
      await customAlert(t.dialog.apiKeyRequired, t.handlers.apiKeyRequiredSimple, 'warning');
      setActiveTab('system');
      return;
    }

    const confirmed = await customConfirm(
      t.dialog.reacquireAllFeeds || 'フィード先全再取得',
      t.handlers.reacquireAllFeedsConfirm || 'すべてのカテゴリのフィード先を再取得しますか？'
    );
    if (!confirmed) return;

    setIsReacquiring(true);
    try {
      const result = await nexusApi.reacquireAllFeeds();
      if (result.success) {
        setDraft(prev => ({
          ...prev,
          feedConfig: result.feedConfig
        }));
        await customAlert(
          t.dialog.reacquireComplete || '再取得完了',
          t.handlers.reacquireSuccess || 'フィード先を再取得しました。',
          'success'
        );
        // 設定を保存する
        await onSave({
          ...draft,
          feedConfig: result.feedConfig
        });
      } else {
        throw new Error('Reacquire failed');
      }
    } catch (err) {
      await handleError(err, t.dialog.reacquireFailed || '再取得失敗', 'Failed to reacquire feeds');
    } finally {
      setIsReacquiring(false);
    }
  }, [apiKey, customAlert, customConfirm, onSave, draft, t, setDraft, handleError, setActiveTab]);

  return { isSaving, isTranslating, restructureStep, isReacquiring, handleSave, handleRestructure, handleResetToDefaults, handleReacquireAllFeeds, handleReset: () => setDraft(currentSettings) };
}
