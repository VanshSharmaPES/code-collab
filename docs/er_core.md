# ER diagram: core 8 tables (draft for P1-02)

Mermaid draft matching `db/schema/01_core.sql`. Redraw it in draw.io for the deliverable (export to `docs/er.drawio` and `docs/er.png`), and extend it with the remaining six tables in Week 2.

```mermaid
erDiagram
    users ||--o{ projects : "created_by / mentor_id"
    projects ||--o{ teams : has
    users ||--o{ teams : "lead_id"
    teams ||--o{ team_members : has
    users ||--o{ team_members : "member of"
    projects ||--o{ repositories : has
    repositories ||--o{ commits : has
    repositories ||--o{ issues : has
    repositories ||--o{ pull_requests : has
    users ||--o{ commits : authors
    users ||--o{ issues : "author / assignee"
    users ||--o{ pull_requests : "author / merged_by"

    users {
        bigint id PK
        text email UK
        text full_name
        text password_hash
        text role
        text github_username UK
    }
    projects {
        bigint id PK
        text name UK
        text status
        bigint mentor_id FK
        bigint created_by FK
    }
    teams {
        bigint id PK
        bigint project_id FK
        text name
        bigint lead_id FK
    }
    team_members {
        bigint team_id PK
        bigint user_id PK
        timestamptz joined_at
    }
    repositories {
        bigint id PK
        bigint project_id FK
        text name
        text github_url UK
        boolean is_synthetic
    }
    commits {
        bigint id PK
        bigint repository_id FK
        text sha
        bigint author_id FK
        int additions
        int deletions
        timestamptz committed_at
    }
    issues {
        bigint id PK
        bigint repository_id FK
        int number
        text status
        text priority
        bigint author_id FK
        bigint assignee_id FK
    }
    pull_requests {
        bigint id PK
        bigint repository_id FK
        int number
        text status
        bigint author_id FK
        bigint merged_by FK
    }
```
