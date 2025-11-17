# SSTorytime Setup & Usage Plan

## What is SSTorytime?

SSTorytime is a knowledge graph system based on Semantic Spacetime theory that helps you:
- Capture, structure, and review personal notes
- Create searchable knowledge maps of your thinking
- Visualize connections between ideas
- Learn and remember through organized note-taking

**Key Philosophy**: Knowledge isn't knowledge unless you actually know it. This tool helps you engage with your notes iteratively, not just store them.

## Architecture Overview

### Core Components

1. **N4L (Notes For Learning)** - A simple note-taking language
   - Human-friendly text format for capturing knowledge
   - Supports relationships, context tags, sequences, and references
   - Can be edited in any text editor

2. **PostgreSQL Database** - Backend storage
   - Stores knowledge graph (nodes and relationships)
   - Enables fast searching and path-finding
   - Can run locally, in Docker, or in RAM disk

3. **Go-based Tools** - CLI and server utilities
   - `N4L` - Parser/compiler to validate and upload notes
   - `searchN4L` - Command-line search tool
   - `http_server` - Web interface for browsing
   - `notes` - View notes in page order
   - `pathsolve` - Find paths between concepts
   - `graph_report` - Analyze graph structure
   - `text2N4L` - Convert plain text to N4L format
   - `removeN4L` - Remove uploaded chapters

### How It Works

```
Write Notes (N4L) → Validate/Parse → Upload to PostgreSQL → Search/Browse/Analyze
                        ↑                                          ↓
                        └──────────── Iterate & Refine ←──────────┘
```

## Current System Status

### ✅ Already Installed
- PostgreSQL 17.4
- Go 1.24.3
- Pre-built executables in `src/` directory

### ❌ Not Yet Set Up
- PostgreSQL database not running (neither system service nor Docker)
- No SSTorytime database created
- No custom configuration (`~/.SSTorytime`)

## Setup Steps

### Option 1: Docker Setup (Recommended for Getting Started)

1. **Start PostgreSQL in Docker**
   ```bash
   cd postgres-docker
   docker compose up -d
   ```
   This creates a database with default credentials:
   - Database: `sstoryline`
   - User: `sstoryline`
   - Password: `sst_1234`
   - Port: 5432

2. **Build the tools** (if needed)
   ```bash
   cd src
   make
   ```

3. **Test with examples**
   ```bash
   cd examples
   make  # Uploads example files
   ```

4. **Start the web server**
   ```bash
   cd src
   ./http_server
   # Access at http://localhost:8080
   ```

### Option 2: System PostgreSQL Setup

1. **Start PostgreSQL service**
   ```bash
   sudo systemctl enable postgresql
   sudo systemctl start postgresql
   ```

2. **Create database** (as postgres user)
   ```bash
   sudo su - postgres
   psql
   ```
   ```sql
   CREATE USER sstoryline PASSWORD 'sst_1234' superuser;
   CREATE DATABASE sstoryline;
   GRANT ALL PRIVILEGES ON DATABASE sstoryline TO sstoryline;
   CREATE EXTENSION UNACCENT;
   ```

3. **Configure access** - Edit `/var/lib/pgsql/data/pg_hba.conf`:
   ```
   host    all    all    127.0.0.1/32    password
   ```

4. **Restart PostgreSQL**
   ```bash
   sudo systemctl restart postgresql
   ```

### Option 3: RAM Disk (Fast, but data lost on reboot)

See `docs/GettingStarted.md` for RAM disk setup instructions.

## Using SSTorytime

### The 5-Step Process

1. **JOT IT DOWN** - Capture ideas when they occur
2. **TYPE INTO N4L** - Format as N4L as soon as possible
3. **ORGANIZE DAILY** - Tidy and structure your notes
4. **UPLOAD & BROWSE** - Put into database and explore
5. **REVIEW & LEARN** - Remember, it's not knowledge if you don't know it!

### Basic N4L Syntax

```n4l
# Comments start with # or //

-chapter name                    # Declare a chapter/section

:: context, tags, keywords ::    # Set context for following notes

Item A                           # A simple note
Item A (relationship) Item B     # Two related items
   "   (another) Item C         # Continue from previous item (")

@label Special item              # Create a reference label
$label.1 (refers to) Something  # Reference the labeled item

NOTE IN ALL CAPS                 # Creates a reminder/todo
```

### Four Types of Relationships

All relationships must fall into one of these categories:

1. **Similarity** (0) - Things are alike/near: `(sounds like)`, `(similar to)`
2. **Leads To** (1) - Causality/sequence: `(causes)`, `(then)`, `(before)`
3. **Contains** (2) - Membership/hierarchy: `(contains)`, `(part of)`, `(example of)`
4. **Properties** (3) - Attributes: `(means)`, `(has property)`, `(note)`

### Common Workflows

#### Validate notes without uploading
```bash
./N4L mynotes.n4l
./N4L -v mynotes.n4l  # Verbose output
```

#### Upload notes to database
```bash
./N4L -u mynotes.n4l              # Add to existing data
./N4L -u -wipe mynotes.n4l        # Replace all data
```

#### Search the database
```bash
./searchN4L "search term"
./searchN4L notes about chinese context restaurant
./searchN4L from "node A" to "node B"
```

#### Browse via web interface
```bash
./http_server
# Visit http://localhost:8080
```

## Importing Org-Roam Files

### Strategy for Org-Roam → N4L Conversion

Since org-roam files are plain text with org-mode syntax:

1. **Manual conversion** (best for learning)
   - Extract key concepts from each org file
   - Identify relationships between concepts
   - Write in N4L format with appropriate contexts

2. **Semi-automated conversion**
   - Use `text2N4L` to create initial structure:
     ```bash
     ./text2N4L your-org-file.org
     ```
   - Edit the generated `.n4l` file to:
     - Add proper relationships
     - Set appropriate contexts
     - Remove org-mode syntax artifacts

3. **Org-mode specific considerations**
   - Org headings → N4L chapters (`-heading`)
   - Org tags → N4L contexts (`:: tags ::`)
   - Org links `[[link]]` → N4L relationships `(related to)`
   - Org TODO items → ALL CAPS notes in N4L

### Example Conversion

**Org-roam file:**
```org
#+TITLE: Knowledge Management
#+ROAM_TAGS: productivity tools

* Zettelkasten
A note-taking method using atomic notes.

** Benefits
- Encourages deep thinking
- Creates unexpected connections
```

**N4L equivalent:**
```n4l
-knowledge management notes

:: productivity, tools ::

Zettelkasten (is a) note-taking method
    "        (uses) atomic notes
    "        (has benefit) Encourages deep thinking
    "        (has benefit) Creates unexpected connections
```

## Key Files & Directories

```
SSTorytime/
├── src/              # Go source code and built executables
│   ├── N4L           # Main compiler/uploader
│   ├── searchN4L     # Search tool
│   ├── http_server   # Web interface (build from server/http_server.go)
│   └── ...           # Other tools
├── examples/         # Sample N4L files
├── docs/             # Comprehensive documentation
├── SSTconfig/        # Relationship definitions (arrows)
│   ├── arrows-LT-1.sst   # Leads-to relationships
│   ├── arrows-NR-0.sst   # Near/similarity relationships
│   ├── arrows-CN-2.sst   # Contains relationships
│   └── arrows-EP-3.sst   # Property relationships
├── postgres-docker/  # Docker setup files
└── pkg/SSTorytime/   # Go library/API

Config file (optional): ~/.SSTorytime
```

## Customization

### Custom Database Credentials

Create `~/.SSTorytime`:
```
dbname: my_sstoryline
user: my_sstoryline_user
passwd: my_password
```

### Custom Relationships

Edit files in `SSTconfig/` to add your own relationships:
- `arrows-LT-1.sst` for sequential/causal
- `arrows-CN-2.sst` for hierarchical
- `arrows-EP-3.sst` for descriptive
- `arrows-NR-0.sst` for similarity

Format:
```
+ forward reading (abbrev) - reverse reading (reverse_abbrev)
```

## Quick Reference

### Essential Commands

```bash
# Setup
cd postgres-docker && docker compose up -d    # Start database
cd src && make                                # Build tools

# Daily workflow
cd src
./N4L -v ~/notes/today.n4l                    # Validate
./N4L -u ~/notes/today.n4l                    # Upload
./searchN4L "topic"                           # Search
./http_server                                 # Web UI

# Maintenance
docker compose down                           # Stop database
./removeN4L chapter_name                      # Remove chapter
```

### Useful Documentation

- `docs/Tutorial.md` - Step-by-step tutorial
- `docs/N4L.md` - Complete N4L language reference
- `docs/GettingStarted.md` - Installation details
- `docs/FAQ.md` - Common questions
- `docs/searchN4L.md` - Search examples

## Next Steps

### Immediate Tasks

1. ✅ Create this plan document
2. ⬜ Start PostgreSQL (Docker or system service)
3. ⬜ Build tools if needed (`cd src && make`)
4. ⬜ Upload example data (`cd examples && make`)
5. ⬜ Test web interface (`./src/http_server`)
6. ⬜ Create first personal N4L file
7. ⬜ Experiment with org-roam conversion

### Learning Path

1. Start with simple notes in N4L
2. Upload and browse via web interface
3. Learn search syntax
4. Experiment with relationships
5. Try converting one org-roam file
6. Develop personal note-taking workflow
7. Explore advanced features (path solving, graph analysis)

## Tips for Success

- **Start small**: Don't try to convert everything at once
- **Iterate**: The value is in revisiting and refining notes
- **Be consistent**: Use consistent relationship names
- **Use contexts**: Tag notes with relevant contexts for better retrieval
- **Review regularly**: Knowledge requires active engagement
- **Don't over-structure**: N4L is flexible by design

## Project Links

- **LinkedIn Group**: [SSTorytime Discussion](https://www.linkedin.com/groups/15875004/)
- **NLnet Funding**: [Smart Semantic Data Lookup](https://nlnet.nl/project/SmartSemanticDataLookup/)
- **Background Reading**: See README.md for Medium article series

---

**Remember**: This is a tool for personal knowledge management. The value comes from the process of writing, organizing, and reviewing - not just from having a database.
