import { Octokit } from '@octokit/rest';
import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import type { AppConfig, AppPage, PageComponent } from '@/types/app-development';

export class GitHubIntegrationService {
  private octokit: Octokit;

  constructor(accessToken: string) {
    this.octokit = new Octokit({
      auth: accessToken,
    });
  }

  /**
   * Create a new repository for the app
   */
  async createRepository(appName: string, description?: string, isPrivate = true): Promise<{ repo_url: string; owner_username: string }> {
    try {
      // Sanitize repo name
      const repoName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
      
      const { data: repo } = await this.octokit.repos.create({
        name: repoName,
        description: description || `Flutter app: ${appName}`,
        private: isPrivate,
        auto_init: true,
        gitignore_template: 'Dart',
        license_template: 'mit',
      });

      return {
        repo_url: repo.html_url,
        owner_username: repo.owner.login,
      };
    } catch (error) {
      logger.error('Error creating GitHub repository:', error);
      throw new Error('Failed to create repository');
    }
  }

  /**
   * Generate Flutter project files from app configuration
   */
  async generateFlutterProject(app: AppConfig, pages: AppPage[], components: PageComponent[]): Promise<Record<string, string>> {
    const files: Record<string, string> = {};

    // pubspec.yaml
    files['pubspec.yaml'] = this.generatePubspecYaml(app);

    // main.dart
    files['lib/main.dart'] = this.generateMainDart(app, pages);

    // Generate page files
    for (const page of pages) {
      const pageComponents = components.filter(c => c.page_id === page.id);
      files[`lib/pages/${page.name.toLowerCase()}_page.dart`] = this.generatePageDart(page, pageComponents);
    }

    // App theme
    files['lib/theme/app_theme.dart'] = this.generateAppTheme(app);

    // Routes
    files['lib/routes/app_routes.dart'] = this.generateAppRoutes(pages);

    // Constants
    files['lib/constants/app_constants.dart'] = this.generateAppConstants(app);

    // README.md
    files['README.md'] = this.generateReadme(app);

    // .gitignore (Flutter specific)
    files['.gitignore'] = this.generateGitignore();

    return files;
  }

  /**
   * Push generated files to repository
   */
  async pushToRepository(owner: string, repo: string, files: Record<string, string>, commitMessage: string): Promise<void> {
    try {
      // Get the current branch SHA
      const { data: ref } = await this.octokit.git.getRef({
        owner,
        repo,
        ref: 'heads/main',
      });

      const currentSha = ref.object.sha;

      // Get the current tree
      const { data: currentCommit } = await this.octokit.git.getCommit({
        owner,
        repo,
        commit_sha: currentSha,
      });

      // Create blobs for all files
      const fileBlobs = await Promise.all(
        Object.entries(files).map(async ([path, content]) => {
          const { data: blob } = await this.octokit.git.createBlob({
            owner,
            repo,
            content: Buffer.from(content).toString('base64'),
            encoding: 'base64',
          });
          
          return {
            path,
            mode: '100644' as const,
            type: 'blob' as const,
            sha: blob.sha,
          };
        })
      );

      // Create new tree
      const { data: newTree } = await this.octokit.git.createTree({
        owner,
        repo,
        base_tree: currentCommit.tree.sha,
        tree: fileBlobs,
      });

      // Create new commit
      const { data: newCommit } = await this.octokit.git.createCommit({
        owner,
        repo,
        message: commitMessage,
        tree: newTree.sha,
        parents: [currentSha],
      });

      // Update reference
      await this.octokit.git.updateRef({
        owner,
        repo,
        ref: 'heads/main',
        sha: newCommit.sha,
      });

      logger.info(`Successfully pushed ${Object.keys(files).length} files to ${owner}/${repo}`);
    } catch (error) {
      logger.error('Error pushing to repository:', error);
      throw new Error('Failed to push files to repository');
    }
  }

  /**
   * Sync app to GitHub repository
   */
  async syncAppToGitHub(appId: string, userId: string): Promise<void> {
    try {
      // Get app data
      const { data: app } = await supabase.serviceClient
        .from('apps')
        .select('*')
        .eq('id', appId)
        .single();

      if (!app) {
        throw new Error('App not found');
      }

      // Get GitHub repository info
      const { data: githubRepo } = await supabase.serviceClient
        .from('github_repositories')
        .select('*')
        .eq('app_id', appId)
        .single();

      if (!githubRepo) {
        throw new Error('GitHub repository not configured');
      }

      // Get pages and components
      const { data: pages } = await supabase.serviceClient
        .from('app_pages')
        .select('*')
        .eq('app_id', appId);

      const { data: components } = await supabase.serviceClient
        .from('page_components')
        .select(`
          *,
          app_pages!inner(app_id)
        `)
        .eq('app_pages.app_id', appId);

      // Generate Flutter project files
      const files = await this.generateFlutterProject(app, pages || [], components || []);

      // Push to GitHub
      const [owner, repoName] = githubRepo.repo_url.split('/').slice(-2);
      const cleanRepoName = repoName.replace('.git', '');

      await this.pushToRepository(
        owner,
        cleanRepoName,
        files,
        `Update from MakeVia - ${new Date().toISOString()}`
      );

      // Update sync status
      await supabase.serviceClient
        .from('github_repositories')
        .update({
          last_sync_at: new Date().toISOString(),
          sync_status: 'completed',
          sync_error_message: null,
        })
        .eq('app_id', appId);

      // Log activity
      await supabase.serviceClient
        .from('app_activity_log')
        .insert({
          app_id: appId,
          user_id: userId,
          action_type: 'github_sync',
          action_description: `Synced app to GitHub: ${githubRepo.repo_url}`,
        });

    } catch (error) {
      logger.error('Error syncing app to GitHub:', error);
      
      // Update sync status with error
      await supabase.serviceClient
        .from('github_repositories')
        .update({
          sync_status: 'failed',
          sync_error_message: error instanceof Error ? error.message : 'Unknown error',
        })
        .eq('app_id', appId);

      throw error;
    }
  }

  private generatePubspecYaml(app: AppConfig): string {
    const dependencies = [
      'flutter:',
      '  sdk: flutter',
      'cupertino_icons: ^1.0.6',
    ];

    return `name: ${app.package_name?.split('.').pop() || app.name.toLowerCase().replace(/[^a-z0-9]/g, '')}
description: ${app.description || 'A Flutter application built with MakeVia'}
publish_to: 'none'
version: ${app.version_name}+${app.version_code}

environment:
  sdk: '>=3.1.0 <4.0.0'
  flutter: ">=3.13.0"

dependencies:
  ${dependencies.join('\n  ')}

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^3.0.0

flutter:
  uses-material-design: true
  
  # Generated with MakeVia - https://makevia.com
`;
  }

  private generateMainDart(app: AppConfig, pages: AppPage[]): string {
    const homePage = pages.find(p => p.is_home_page);
    const homePageClass = homePage ? `${this.toPascalCase(homePage.name)}Page` : 'HomePage';

    return `import 'package:flutter/material.dart';
import 'theme/app_theme.dart';
import 'routes/app_routes.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '${app.name}',
      theme: AppTheme.lightTheme,
      darkTheme: AppTheme.darkTheme,
      themeMode: ${this.getThemeMode(app.theme_mode)},
      initialRoute: '/',
      routes: AppRoutes.routes,
      debugShowCheckedModeBanner: false,
    );
  }
}

// Generated with MakeVia - https://makevia.com
`;
  }

  private generatePageDart(page: AppPage, components: PageComponent[]): string {
    const className = `${this.toPascalCase(page.name)}Page`;
    const widgets = components.map(component => this.generateWidgetCode(component)).join('\n          ');

    return `import 'package:flutter/material.dart';

class ${className} extends StatefulWidget {
  const ${className}({super.key});

  @override
  State<${className}> createState() => _${className}State();
}

class _${className}State extends State<${className}> {
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      ${page.app_bar_config.show ? `appBar: AppBar(
        title: Text('${page.app_bar_config.title || page.title}'),
        backgroundColor: ${this.colorToFlutter(page.app_bar_config.backgroundColor)},
        elevation: ${page.app_bar_config.elevation},
      ),` : ''}
      body: Stack(
        children: [
          ${widgets || '// Add components here'}
        ],
      ),
    );
  }
}

// Generated with MakeVia - https://makevia.com
`;
  }

  private generateWidgetCode(component: PageComponent): string {
    const props = component.properties || {};
    
    switch (component.flutter_widget_name) {
      case 'Text':
        return `Positioned(
            left: ${component.position_x},
            top: ${component.position_y},
            child: Text(
              '${props.text || 'Sample Text'}',
              style: TextStyle(
                fontSize: ${props.fontSize || 16},
                color: ${this.colorToFlutter(props.color)},
              ),
            ),
          )`;
      
      case 'ElevatedButton':
        return `Positioned(
            left: ${component.position_x},
            top: ${component.position_y},
            child: ElevatedButton(
              onPressed: () {
                // TODO: Implement button action
              },
              child: Text('${props.text || 'Button'}'),
            ),
          )`;
      
      case 'TextField':
        return `Positioned(
            left: ${component.position_x},
            top: ${component.position_y},
            width: ${component.width},
            child: TextField(
              decoration: InputDecoration(
                hintText: '${props.hintText || 'Enter text...'}',
                labelText: '${props.labelText || ''}',
              ),
              obscureText: ${props.obscureText || false},
            ),
          )`;
      
      case 'Container':
        return `Positioned(
            left: ${component.position_x},
            top: ${component.position_y},
            width: ${component.width},
            height: ${component.height},
            child: Container(
              decoration: BoxDecoration(
                color: ${this.colorToFlutter(props.backgroundColor)},
                borderRadius: BorderRadius.circular(${props.borderRadius || 0}),
              ),
            ),
          )`;
      
      default:
        return `Positioned(
            left: ${component.position_x},
            top: ${component.position_y},
            child: ${component.flutter_widget_name}(),
          )`;
    }
  }

  private generateAppTheme(app: AppConfig): string {
    return `import 'package:flutter/material.dart';

class AppTheme {
  static ThemeData get lightTheme {
    return ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(
        seedColor: ${this.colorToFlutter(app.primary_color)},
        brightness: Brightness.light,
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: ${this.colorToFlutter(app.primary_color)},
        foregroundColor: Colors.white,
      ),
    );
  }

  static ThemeData get darkTheme {
    return ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(
        seedColor: ${this.colorToFlutter(app.primary_color)},
        brightness: Brightness.dark,
      ),
    );
  }
}

// Generated with MakeVia - https://makevia.com
`;
  }

  private generateAppRoutes(pages: AppPage[]): string {
    const imports = pages.map(page => 
      `import '../pages/${page.name.toLowerCase()}_page.dart';`
    ).join('\n');

    const routes = pages.map(page => {
      const className = `${this.toPascalCase(page.name)}Page`;
      return `    '${page.route_path}': (context) => const ${className}(),`;
    }).join('\n');

    return `import 'package:flutter/material.dart';
${imports}

class AppRoutes {
  static Map<String, WidgetBuilder> get routes {
    return {
${routes}
    };
  }
}

// Generated with MakeVia - https://makevia.com
`;
  }

  private generateAppConstants(app: AppConfig): string {
    return `class AppConstants {
  static const String appName = '${app.name}';
  static const String appVersion = '${app.version_name}';
  static const int appVersionCode = ${app.version_code};
  static const String packageName = '${app.package_name}';
  
  // API Configuration
  static const String baseUrl = ''; // TODO: Add your API base URL
  
  // App Configuration
  static const bool isDebugMode = true; // Set to false for release
}

// Generated with MakeVia - https://makevia.com
`;
  }

  private generateReadme(app: AppConfig): string {
    return `# ${app.name}

${app.description || 'A Flutter application built with MakeVia'}

## Getting Started

This Flutter project was generated using [MakeVia](https://makevia.com), a visual app builder platform.

### Prerequisites

- [Flutter SDK](https://flutter.dev/docs/get-started/install) (${app.flutter_version} or later)
- [Dart SDK](https://dart.dev/get-dart) (${app.dart_version} or later)

### Installation

1. Clone this repository
2. Navigate to the project directory
3. Install dependencies:
   \`\`\`bash
   flutter pub get
   \`\`\`

### Running the App

To run the app in debug mode:

\`\`\`bash
flutter run
\`\`\`

### Building for Release

For Android:
\`\`\`bash
flutter build apk --release
\`\`\`

For iOS:
\`\`\`bash
flutter build ios --release
\`\`\`

## Project Structure

- \`lib/main.dart\` - App entry point
- \`lib/pages/\` - App screens/pages
- \`lib/theme/\` - App theming
- \`lib/routes/\` - Navigation routes
- \`lib/constants/\` - App constants

## Features

${Object.entries(app.capabilities)
  .filter(([, enabled]) => enabled)
  .map(([feature]) => `- ${feature.replace(/_/g, ' ')}`)
  .join('\n')}

## Generated with MakeVia

This project was created using [MakeVia](https://makevia.com) - A visual Flutter app builder.

---

*Last updated: ${new Date().toISOString()}*
`;
  }

  private generateGitignore(): string {
    return `# Miscellaneous
*.class
*.log
*.pyc
*.swp
.DS_Store
.atom/
.buildlog/
.history
.svn/
migrate_working_dir/

# IntelliJ related
*.iml
*.ipr
*.iws
.idea/

# Flutter/Dart/Pub related
**/doc/api/
**/ios/Flutter/.last_build_id
.dart_tool/
.flutter-plugins
.flutter-plugins-dependencies
.packages
.pub-cache/
.pub/
/build/

# Symbolication related
app.*.symbols

# Obfuscation related
app.*.map.json

# Android Studio will place build artifacts here
/android/app/debug
/android/app/profile
/android/app/release
`;
  }

  private toPascalCase(str: string): string {
    return str.replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index) => {
      return index === 0 ? word.toUpperCase() : word.toUpperCase();
    }).replace(/\s+/g, '');
  }

  private colorToFlutter(color?: string): string {
    if (!color) return 'Colors.blue';
    if (color.startsWith('#')) {
      return `Color(0xFF${color.substring(1)})`;
    }
    return 'Colors.blue';
  }

  private getThemeMode(mode: string): string {
    switch (mode) {
      case 'dark': return 'ThemeMode.dark';
      case 'light': return 'ThemeMode.light';
      default: return 'ThemeMode.system';
    }
  }
}

export default GitHubIntegrationService;