import { readdir, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { BaseAdapter } from './base.js';
import type {
  ToolDetection,
  TemplateConfig,
  InstallResult,
  ComponentType,
  PathTransform,
} from '../../types/index.js';

/**
 * Adapter for Gemini CLI
 *
 * Structure:
 * - ~/.gemini/agents/*.md (Agent definitions)
 * - ~/.gemini/skills/<name>/SKILL.md (Skill definitions)
 * - ~/.gemini/settings.json (Global settings)
 * - .gemini/settings.json (Project-level settings)
 */
export class GeminiAdapter extends BaseAdapter {
  readonly tool = 'gemini' as const;
  readonly name = 'Gemini CLI';
  readonly description = 'Google Gemini CLI';

  private readonly globalDir = join(homedir(), '.gemini');

  getGlobalConfigDir(): string {
    return this.globalDir;
  }

  getProjectConfigPath(projectRoot: string): string {
    return join(projectRoot, '.gemini/settings.json');
  }

  async detect(): Promise<ToolDetection> {
    const configExists = await this.pathExists(this.globalDir);
    const settingsPath = join(this.globalDir, 'settings.json');
    const settingsExist = await this.pathExists(settingsPath);

    // Check if 'gemini' command exists in PATH
    const commandExists = this.commandExists('gemini');

    // Tool is installed if command exists OR if config directory with settings exists
    const installed = commandExists || (configExists && settingsExist);

    return {
      tool: this.tool,
      installed,
      configPath: configExists ? this.globalDir : null,
    };
  }

  protected getDefaultTransforms(projectRoot?: string): PathTransform[] {
    return [
      { type: 'variable', from: 'DOCS', to: join(this.globalDir, 'docs') },
      { type: 'variable', from: 'PROJECT', to: projectRoot || '.' },
      { type: 'variable', from: 'HOME', to: homedir() },
      { type: 'variable', from: 'CONFIG', to: this.globalDir },
    ];
  }

  async install(
    template: TemplateConfig,
    content: string,
    projectRoot?: string
  ): Promise<InstallResult> {
    const target = template.targets.gemini;
    if (!target) {
      return {
        template,
        tool: this.tool,
        success: false,
        targetPath: '',
        error: 'No Gemini target configured for this template',
      };
    }

    try {
      // Apply transforms to content
      const transforms = [
        ...this.getDefaultTransforms(projectRoot),
        ...(template.transforms || []),
      ];
      const transformedContent = this.transformContent(content, transforms);

      // Transform and expand target path
      let targetPath = this.transformPath(target.path, projectRoot);
      if (targetPath.startsWith('~')) {
        targetPath = targetPath.replace('~', homedir());
      } else if (projectRoot && !targetPath.startsWith('/')) {
        targetPath = join(projectRoot, targetPath);
      }

      // Special handling for skills and agents, which are installed as skills
      if (template.type === 'skills' || template.type === 'agents') {
        const skillDir = dirname(targetPath);
        await mkdir(skillDir, { recursive: true });
      }

      await this.writeConfig(targetPath, transformedContent);

      return {
        template,
        tool: this.tool,
        success: true,
        targetPath,
      };
    } catch (error) {
      return {
        template,
        tool: this.tool,
        success: false,
        targetPath: target.path,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async listInstalled(type: ComponentType): Promise<string[]> {
    const dirMap: Record<ComponentType, string> = {
      commands: join(this.globalDir, 'agents'), // Commands remain as sub-agents
      agents: join(this.globalDir, 'skills'),   // Agents are now installed as skills
      skills: join(this.globalDir, 'skills'),
      templates: join(this.globalDir, 'docs'),
    };

    const dir = dirMap[type];
    if (!(await this.pathExists(dir))) {
      return [];
    }

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      if (type === 'skills' || type === 'agents') {
        // Skills and Agents are directories with SKILL.md inside
        const skills: string[] = [];
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (await this.pathExists(join(dir, entry.name, 'SKILL.md'))) {
              skills.push(entry.name);
            }
          }
        }
        return skills;
      }

      // Commands are .md files
      return entries
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name.replace('.md', ''));
    } catch {
      return [];
    }
  }
}
