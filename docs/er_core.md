# ER diagram: core 8 tables (P1-02)

Mermaid source matching `db/schema/01_core.sql`. Render it with `docs/render_er.sh`, or paste the block into draw.io via Arrange → Insert → Advanced → Mermaid. Extend it with the remaining six tables in Week 2 (P1-05).

Notation: `||` = exactly one (mandatory FK), `|o` = zero or one (nullable FK), `o{` = zero or many.

```mermaid
erDiagram
    users ||--o{ team_members : joins
    teams ||--o{ team_members : has
    projects ||--o{ teams : has
    users |o--o{ teams : leads
    users |o--o{ projects : mentors
    users |o--o{ projects : created
    projects ||--o{ repositories : has
    repositories ||--o{ commits : has
    repositories ||--o{ issues : has
    repositories ||--o{ pull_requests : has
    users |o--o{ commits : authored
    users |o--o{ issues : reported
    users |o--o{ issues : assigned
    users |o--o{ pull_requests : opened
    users |o--o{ pull_requests : merged

    users {
        bigint id PK
        text email UK
        text full_name
        text password_hash
        text role "student, lead or mentor"
        text github_username UK
        timestamptz created_at
    }
    projects {
        bigint id PK
        text name UK
        text description
        text status "active or archived"
        bigint mentor_id FK
        bigint created_by FK
        timestamptz created_at
    }
    teams {
        bigint id PK
        bigint project_id FK
        text name "unique per project"
        bigint lead_id FK
        timestamptz created_at
    }
    team_members {
        bigint team_id PK, FK
        bigint user_id PK, FK
        timestamptz joined_at
    }
    repositories {
        bigint id PK
        bigint project_id FK
        text name "unique per project"
        text github_url UK
        text default_branch
        boolean is_synthetic
        timestamptz created_at
    }
    commits {
        bigint id PK
        bigint repository_id FK
        text sha "unique per repository"
        bigint author_id FK
        text author_name
        text author_email
        text message
        int additions
        int deletions
        int files_changed
        timestamptz committed_at
    }
    issues {
        bigint id PK
        bigint repository_id FK
        int number "unique per repository"
        text title
        text body
        text status "open, in_progress or closed"
        text priority "low to critical"
        bigint author_id FK
        bigint assignee_id FK
        timestamptz created_at
        timestamptz updated_at
        timestamptz closed_at
    }
    pull_requests {
        bigint id PK
        bigint repository_id FK
        int number "unique per repository"
        text title
        text description
        text status "open, approved, merged or closed"
        bigint author_id FK
        bigint merged_by FK
        timestamptz created_at
        timestamptz updated_at
        timestamptz merged_at
    }
```
