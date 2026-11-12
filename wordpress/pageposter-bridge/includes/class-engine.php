<?php
namespace PagePoster\Bridge;

/**
 * The storage adapter owns one non-retrying InnoDB connection. There are no WordPress
 * save hooks in this transaction: an arbitrary hook cannot make the ledger non-atomic.
 */
final class Engine {
    private $db;
    private $clock;
    public function __construct($database, ?callable $clock = null) {
        $this->db = $database;
        $this->clock = $clock ?? static function () { return gmdate('Y-m-d\TH:i:s\Z'); };
    }
    private function result(array $input, array $post, string $state, ?array $before, string $createdAt): array {
        return [
            'operationId' => $input['operationId'], 'kind' => $input['kind'], 'state' => $state,
            'replayed' => false, 'postId' => (int) $post['ID'],
            'contentHash' => Contract::contentHash($post),
            'previousContentHash' => $before ? Contract::contentHash($before) : null,
            'postType' => $post['post_type'], 'status' => $post['post_status'], 'url' => $this->db->url($post),
            'createdAt' => $createdAt, 'completedAt' => ($this->clock)(),
            'warnings' => $state === 'conflict' ? ['The current WordPress snapshot differs from the expected snapshot.'] :
                ($input['kind']==='adopt' ? ['Existing content, title and status were preserved exactly; only the managed association was registered.'] : ['Static content was stored without WordPress save/transition hooks. Public rendering and caches require verification.'])
        ] + (isset($post['post_modified_gmt']) ? ['modifiedGmt' => (string)$post['post_modified_gmt']] : []);
    }
    public function execute($input, int $ownerId, callable $authorize): array {
        $input = Contract::validate($input);
        if ($ownerId < 1) throw new Fault('pp_bridge_authentication', 'Application Password authentication is required.', 401);
        if (!$this->db->ready()) throw new Fault('pp_bridge_unsupported_storage', 'Atomic InnoDB storage is required.', 503);
        $begun = false;
        $commitAttempted = false;
        try {
            $this->db->begin();
            $begun = true;
            $token = bin2hex(random_bytes(24));
            $operation = $this->db->claimOperation($input['operationId'], $ownerId, Contract::payloadHash($input), $input['kind'], $token, ($this->clock)());
            if ((int) $operation['owner_id'] !== $ownerId) throw new Fault('pp_bridge_operation_owner', 'This operation belongs to another account.', 403);
            if (!hash_equals($operation['payload_hash'], Contract::payloadHash($input))) throw new Fault('pp_bridge_idempotency_conflict', 'This operationId has a different payload.', 409);
            if ($operation['execution_token'] !== $token) {
                if (!$operation['result_json']) throw new Fault('pp_bridge_uncertain', 'Operation outcome requires reconciliation.', 503);
                $result = json_decode($operation['result_json'], true, 512, JSON_THROW_ON_ERROR);
                $post = $this->db->lockPost((int) $result['postId']);
                if (!$post || ($result['state']==='completed' && !$this->db->isManaged((int) $result['postId'])) || !$authorize($post, $input)) {
                    throw new Fault('pp_bridge_forbidden', 'Current edit permission for this managed post is required.', 403);
                }
                $this->db->rollback();
                $begun = false;
                $result['replayed'] = true;
                return $result;
            }
            $before = null;
            if ($input['kind'] === 'create') {
                if (!$authorize(null, $input)) throw new Fault('pp_bridge_forbidden', 'Creation permission is required.', 403);
                $post = $this->db->insertPost($input, $ownerId, $input['operationId']);
                $state = 'completed';
            } else {
                $before = $this->db->lockPost($input['postId']);
                if (!$before) throw new Fault('pp_bridge_not_found', 'Post was not found.', 404);
                if (($input['kind']!=='adopt' && !$this->db->isManaged($input['postId'])) || !Contract::marked($before['post_content'])) {
                    throw new Fault('pp_bridge_unmanaged', 'Only Bridge-managed PagePoster posts can be changed.', 403);
                }
                if (!$authorize($before, $input)) throw new Fault('pp_bridge_forbidden', 'Edit permission is required.', 403);
                if ($before['post_type'] !== $input['postType'] || !in_array($before['post_status'], ['draft', 'publish'], true) ||
                    !hash_equals(Contract::contentHash($before), $input['expectedContentHash'])) {
                    $post = $before;
                    $state = 'conflict';
                } elseif ($input['kind']==='adopt') {
                    $this->db->registerManaged($input['postId'],$ownerId,$input['operationId']);
                    $post=$this->db->readPost($input['postId']);
                    if ($post!==$before) throw new Fault('pp_bridge_content_changed','Adoption must preserve the complete original row.',503);
                    $state='completed';
                } else {
                    if (!$this->db->compareAndSwap($before, $input)) {
                        throw new Fault('pp_bridge_cas_conflict', 'The conditional update did not match the locked snapshot.', 409);
                    }
                    $post = $this->db->readPost($input['postId']);
                    $state = 'completed';
                }
            }
            if ($state === 'completed' && $input['kind']!=='adopt') {
                foreach (['post_type' => 'postType', 'post_title' => 'title', 'post_content' => 'content', 'post_status' => 'status'] as $column => $field) {
                    if (!isset($post[$column]) || $post[$column] !== $input[$field]) {
                        throw new Fault('pp_bridge_content_changed', 'Storage did not preserve the exact submitted bytes; the operation was rolled back.', 503);
                    }
                }
            }
            $result = $this->result($input, $post, $state, $before, $operation['created_at']);
            $this->db->completeOperation($input['operationId'], $result, $before);
            $commitAttempted = true;
            $this->db->commit();
            $begun = false;
            return $result;
        } catch (\Throwable $error) {
            $rolledBack = !$begun;
            if ($begun) {
                try { $rolledBack = $this->db->rollback(); } catch (\Throwable $ignored) { $rolledBack = false; }
            }
            if ($commitAttempted || !$rolledBack) {
                throw new Fault('pp_bridge_uncertain', 'The commit outcome is unknown. Read this operationId before taking further action.', 503);
            }
            if ($error instanceof Fault) throw $error;
            throw new Fault('pp_bridge_database_failure', 'The operation was rolled back before commit.', 503);
        }
    }
}
