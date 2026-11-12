<?php
namespace PagePoster\Bridge;

/** Dedicated mysqli session. WordPress's automatic reconnect/retry must not escape this transaction. */
final class Database {
    private \mysqli $connection;
    private array $tables;
    private string $home;
    private string $localTime;
    private string $gmtTime;
    private ?array $storageReasons = null;
    private bool $closed = false;
    private function __construct(\mysqli $connection, array $tables, string $home, string $localTime) {
        $this->connection=$connection; $this->tables=$tables; $this->home=rtrim($home,'/');
        $this->localTime=$localTime; $this->gmtTime=gmdate('Y-m-d H:i:s');
    }
    public static function connect($wpdb): self {
        if (!is_object($wpdb) || get_class($wpdb) !== 'wpdb' || (defined('WP_CONTENT_DIR') && is_file(WP_CONTENT_DIR . '/db.php')) ||
            !extension_loaded('mysqli') || !($wpdb->dbh instanceof \mysqli) || !method_exists($wpdb,'parse_db_host') ||
            !defined('DB_HOST') || !defined('DB_USER') || !defined('DB_PASSWORD') || !defined('DB_NAME')) {
            throw new Fault('pp_bridge_unsupported_storage','A standard WordPress mysqli connection is required.',503);
        }
        $host=$wpdb->parse_db_host(DB_HOST);
        if (!$host || strpos($host[0],'p:')===0) throw new Fault('pp_bridge_unsupported_storage','This database connection is unsupported.',503);
        [$hostname,$port,$socket,$ipv6]=$host;
        if ($ipv6 && extension_loaded('mysqlnd')) $hostname='['.$hostname.']';
        $connection=mysqli_init();
        if (!$connection) throw new Fault('pp_bridge_unsupported_storage','A dedicated database connection could not be created.',503);
        try {
            $connection->options(MYSQLI_OPT_CONNECT_TIMEOUT,5);
            $flags=defined('MYSQL_CLIENT_FLAGS') ? MYSQL_CLIENT_FLAGS : 0;
            $flags &= ~MYSQLI_CLIENT_FOUND_ROWS;
            if (!@$connection->real_connect($hostname,DB_USER,DB_PASSWORD,DB_NAME,$port??0,$socket??null,$flags)) throw new \RuntimeException();
            if (!$connection->set_charset('utf8mb4')) throw new \RuntimeException();
            $tables=['posts'=>$wpdb->posts,'operations'=>$wpdb->prefix.'pageposter_bridge_ops','managed'=>$wpdb->prefix.'pageposter_bridge_pages'];
            foreach ($tables as $table) if (!preg_match('/^[A-Za-z0-9_]{1,64}$/D',$table)) throw new \RuntimeException();
            $db=new self($connection,$tables,(string)get_option('home'),current_time('mysql'));
            $db->query('SET SESSION innodb_lock_wait_timeout=5');
            return $db;
        } catch (\Throwable $error) {
            try {$connection->close();} catch (\Throwable $ignored) {}
            throw new Fault('pp_bridge_unsupported_storage','A dedicated transactional database connection is unavailable.',503);
        }
    }
    private function table(string $key): string {return chr(96).$this->tables[$key].chr(96);}
    /** No reconnect, retry, wpdb query hooks, raw SQL logging, or implicit transaction recovery. */
    private function query(string $sql,array $values=[]): array {
        if ($this->closed) throw new \RuntimeException('Database connection is closed.');
        $statement=$this->connection->prepare($sql);
        if (!$statement) throw new \RuntimeException('Database statement failed.');
        try {
            if ($values) {$types=str_repeat('s',count($values)); $statement->bind_param($types,...$values);}
            if (!$statement->execute()) throw new \RuntimeException('Database statement failed.');
            $rows=[];
            if ($statement->field_count>0) {
                $result=$statement->get_result();
                if ($result===false) throw new \RuntimeException('Database result is unavailable.');
                $rows=$result->fetch_all(MYSQLI_ASSOC); $result->free();
            }
            return ['rows'=>$rows,'affected'=>$statement->affected_rows,'insertId'=>$statement->insert_id];
        } finally {$statement->close();}
    }
    private function row(string $sql,array $values=[]): ?array {$r=$this->query($sql,$values); return $r['rows'][0]??null;}

    /**
     * information_schema.TRIGGERS hides rows without TRIGGER privilege.
     * Accept only directly demonstrated scope; do not infer role expansion or partial-revoke semantics.
     */
    public static function hasTriggerVisibility(array $grants,string $database,array $tables): bool {
        if ($database==='' || strlen($database)>64 || !$tables || count($grants)>1000) return false;
        $covered=[];
        foreach ($tables as $table) {
            if (!is_string($table) || !preg_match('/^[A-Za-z0-9_]{1,64}$/D',$table)) return false;
            $covered[$table]=false;
        }
        foreach ($grants as $grant) {
            if (!is_string($grant) || preg_match('/^\s*REVOKE\b/i',$grant)) return false;
        }
        $identifier=function(string $value): string {
            return $value[0]===chr(96) ? str_replace(chr(96).chr(96),chr(96),substr($value,1,-1)) : $value;
        };
        foreach ($grants as $grant) {
            if (!preg_match('~^GRANT\s+(.+?)\s+ON\s+((?:\x60(?:[^\x60]|\x60\x60)+\x60)|[A-Za-z0-9_$]+|\*)\s*\.\s*((?:\x60(?:[^\x60]|\x60\x60)+\x60)|[A-Za-z0-9_$]+|\*)\s+TO\s+.+$~iD',trim($grant),$match)) continue;
            // Quoted roles and column lists can contain misleading commas/ON/TRIGGER text.
            if (!preg_match('/^[A-Za-z_]+(?:\s+[A-Za-z_]+)*(?:\s*,\s*[A-Za-z_]+(?:\s+[A-Za-z_]+)*)*$/D',$match[1])) continue;
            $privileges=array_map('strtoupper',array_map('trim',explode(',',$match[1])));
            if (!in_array('TRIGGER',$privileges,true) && !in_array('ALL PRIVILEGES',$privileges,true) && !in_array('ALL',$privileges,true)) continue;
            $scopeDatabase=$identifier($match[2]); $scopeTable=$identifier($match[3]);
            $databaseWildcard=$match[2]==='*'; $tableWildcard=$match[3]==='*';
            // Multiple matching database wildcard grants have ordering-dependent semantics.
            // Only a literal database scope proves visibility; escaped _/% remain literal.
            $literalDatabase=$scopeDatabase;
            if ($tableWildcard && !$databaseWildcard) {
                $literalDatabase='';
                for ($i=0;$i<strlen($scopeDatabase);$i++) {
                    $character=$scopeDatabase[$i];
                    if ($character==='\\') {
                        if (++$i>=strlen($scopeDatabase) || !in_array($scopeDatabase[$i],['\\','_','%'],true)) {$literalDatabase=null;break;}
                        $character=$scopeDatabase[$i];
                    } elseif ($character==='_' || $character==='%') {$literalDatabase=null;break;}
                    $literalDatabase.=$character;
                }
            }
            $global=$databaseWildcard && $tableWildcard;
            if (!$global && ($databaseWildcard || $literalDatabase!==$database)) continue;
            foreach ($covered as $table=>$allowed) if ($tableWildcard || $scopeTable===$table) $covered[$table]=true;
        }
        return !in_array(false,$covered,true);
    }
    public function reasons(): array {
        if ($this->storageReasons!==null) return $this->storageReasons;
        $reasons=[];
        try {
            $database=$this->row('SELECT DATABASE() AS database_name');
            $grantRows=$this->query('SHOW GRANTS FOR CURRENT_USER()')['rows'];
            $grants=[];
            foreach ($grantRows as $grantRow) {
                if (!is_array($grantRow) || count($grantRow)!==1 || !is_string(reset($grantRow))) throw new \RuntimeException('Database privileges could not be verified.');
                $grants[]=reset($grantRow);
            }
            if (!$database || !self::hasTriggerVisibility($grants,(string)$database['database_name'],array_values($this->tables))) {
                $reasons[]='Direct TRIGGER visibility privileges for every Bridge-managed table must be verified.';
            }
            foreach ($this->tables as $table) {
                $row=$this->row('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[$table]);
                if (!$row || strcasecmp((string)$row['ENGINE'],'InnoDB')!==0) $reasons[]='All Bridge tables and the posts table must use InnoDB.';
                $triggers=$this->row('SELECT COUNT(*) AS total FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?',[$table]);
                if (!$triggers || (int)$triggers['total']!==0) $reasons[]='SQL triggers on Bridge-managed tables are unsupported.';
            }
        } catch (\Throwable $error) {$reasons[]='Transactional storage could not be verified.';}
        return $this->storageReasons=array_values(array_unique($reasons));
    }
    public function ready(): bool {return count($this->reasons())===0;}
    public function install(): void {
        $ops=$this->table('operations'); $managed=$this->table('managed');
        $this->query("CREATE TABLE IF NOT EXISTS $ops (
          operation_id varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          owner_id bigint unsigned NOT NULL,payload_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          execution_token char(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          kind varchar(10) NOT NULL,state varchar(20) NOT NULL,post_id bigint unsigned NULL,
          created_at varchar(30) NOT NULL,completed_at varchar(30) NULL,result_json longtext NULL,before_json longtext NULL,
          PRIMARY KEY(operation_id),KEY post_id(post_id)
        ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin");
        $this->query("CREATE TABLE IF NOT EXISTS $managed (
          post_id bigint unsigned NOT NULL,owner_id bigint unsigned NOT NULL,
          creation_operation varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          PRIMARY KEY(post_id),UNIQUE KEY creation_operation(creation_operation)
        ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin");
        $this->storageReasons=null;
        if (!$this->ready()) throw new Fault('pp_bridge_unsupported_storage','InnoDB storage without SQL triggers is required.',503);
    }
    public function begin(): void {if (!$this->connection->begin_transaction()) throw new \RuntimeException('Transaction could not start.');}
    public function commit(): void {if (!$this->connection->commit()) throw new \RuntimeException('Commit acknowledgement failed.');}
    public function rollback(): bool {return $this->connection->rollback();}
    public function claimOperation(string $id,int $owner,string $hash,string $kind,string $token,string $time): array {
        $table=$this->table('operations');
        $this->query("INSERT INTO $table(operation_id,owner_id,payload_hash,execution_token,kind,state,created_at) VALUES(?,?,?,?,?,'pending',?) ON DUPLICATE KEY UPDATE operation_id=operation_id",[$id,$owner,$hash,$token,$kind,$time]);
        $row=$this->row("SELECT * FROM $table WHERE operation_id=? FOR UPDATE",[$id]);
        if (!$row) throw new \RuntimeException('Operation reservation is unavailable.');
        return $row;
    }
    public function getOperation(string $id): ?array {return $this->row('SELECT * FROM '.$this->table('operations').' WHERE operation_id=?',[$id]);}
    public function lockPost(int $id): ?array {return $this->row('SELECT * FROM '.$this->table('posts').' WHERE ID=? FOR UPDATE',[$id]);}
    public function readPost(int $id): ?array {return $this->row('SELECT * FROM '.$this->table('posts').' WHERE ID=?',[$id]);}
    public function isManaged(int $id): bool {return $this->row('SELECT post_id FROM '.$this->table('managed').' WHERE post_id=?',[$id])!==null;}
    public function registerManaged(int $id,int $owner,string $operation): void {
        $this->query('INSERT INTO '.$this->table('managed').'(post_id,owner_id,creation_operation) VALUES(?,?,?) ON DUPLICATE KEY UPDATE post_id=post_id',[$id,$owner,$operation]);
        if (!$this->isManaged($id)) throw new \RuntimeException('Managed association could not be registered.');
    }
    public function insertPost(array $input,int $owner,string $operation): array {
        $posts=$this->table('posts');
        $result=$this->query("INSERT INTO $posts
          (post_author,post_date,post_date_gmt,post_content,post_title,post_excerpt,post_status,comment_status,ping_status,post_password,post_name,to_ping,pinged,post_modified,post_modified_gmt,post_content_filtered,post_parent,guid,menu_order,post_type,post_mime_type,comment_count)
          VALUES(?,?,?,?,?,'',?,'closed','closed','',?,'','',?,?,'',0,'',0,?,'',0)",
          [$owner,$this->localTime,$this->gmtTime,$input['content'],$input['title'],$input['status'],'pageposter-'.$operation,$this->localTime,$this->gmtTime,$input['postType']]);
        $id=(int)$result['insertId'];
        if ($id<1) throw new \RuntimeException('Post identity is unavailable.');
        $this->query("UPDATE $posts SET guid=? WHERE ID=?",[$this->url(['ID'=>$id,'post_type'=>$input['postType']]),$id]);
        $this->query('INSERT INTO '.$this->table('managed').'(post_id,owner_id,creation_operation) VALUES(?,?,?)',[$id,$owner,$operation]);
        $post=$this->readPost($id);
        if (!$post) throw new \RuntimeException('Created post is unavailable.');
        return $post;
    }
    public function compareAndSwap(array $before,array $input): bool {
        $posts=$this->table('posts');
        $result=$this->query("UPDATE $posts SET post_title=?,post_content=?,post_status=?,post_modified=?,post_modified_gmt=?
          WHERE ID=? AND BINARY post_type = BINARY ? AND BINARY post_title = BINARY ? AND BINARY post_content = BINARY ? AND BINARY post_status = BINARY ?",
          [$input['title'],$input['content'],$input['status'],$this->localTime,$this->gmtTime,$before['ID'],$before['post_type'],$before['post_title'],$before['post_content'],$before['post_status']]);
        if ($result['affected']===1) return true;
        // MySQL reports zero changes for an identical save in the same timestamp second.
        return $result['affected']===0 && $before['post_title']===$input['title'] && $before['post_content']===$input['content'] && $before['post_status']===$input['status'];
    }
    public function completeOperation(string $id,array $result,?array $before): void {
        $json=json_encode($result,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR);
        $snapshot=$before===null?null:json_encode($before,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR);
        $changed=$this->query('UPDATE '.$this->table('operations').' SET state=?,post_id=?,completed_at=?,result_json=?,before_json=? WHERE operation_id=?',[$result['state'],$result['postId'],$result['completedAt'],$json,$snapshot,$id]);
        if ($changed['affected']!==1) throw new \RuntimeException('Operation result could not be recorded.');
    }
    public function url(array $post): string {return $this->home.($post['post_type']==='page'?'/?page_id=':'/?p=').(int)$post['ID'];}
    public function close(): void {if (!$this->closed) {$this->connection->close();$this->closed=true;}}
}
